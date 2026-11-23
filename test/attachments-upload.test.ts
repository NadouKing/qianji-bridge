import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { decodeImageBase64, imageIdentity, imageEtag, imageUploadHost, uploadImage } from "../src/attachments.ts";
import { OperationJournal } from "../src/operation-journal.ts";
import { Store } from "../src/data-store.ts";
import { MoneyTrackService } from "../src/qianji-service.ts";
import { QianjiClient, parseQianjiJson } from "../src/qianji-client.ts";
import test from "./context.ts";

const policy = (hosts: string[]) => "fixture:signature:" + Buffer.from(JSON.stringify({ upHosts: hosts })).toString("base64url");
const png = () => sharp({create: {width: 3, height: 2, channels: 4, background: "#123456"}}).png().toBuffer();

test("image validation fully decodes and rejects malformed data, unsupported formats and arbitrary destinations", async () => {
  const bytes = await png();
  assert.deepEqual(decodeImageBase64(bytes.toString("base64")), bytes);
  assert.equal((await imageIdentity(bytes)).width, 3);
  const jpeg=await sharp(bytes).jpeg().toBuffer();
  assert.equal((await imageIdentity(jpeg)).mime,"image/jpeg");
  const oversized=await sharp({create:{width:5000,height:5000,channels:3,background:"white"}}).png().toBuffer();
  await assert.rejects(imageIdentity(oversized),/2400/);
  await assert.rejects(imageIdentity(bytes.subarray(0, 34)), /解码/);
  await assert.rejects(imageIdentity(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), /PNG/);
  assert.throws(() => decodeImageBase64("data:image/png;base64,AAAA"), /Base64/);
  assert.equal(imageUploadHost(policy(["http://up-z2.qiniu.com"])), "https://upload-z2.qiniup.com/");
  for (const url of ["https://up.qiniu.com.evil.test/", "https://evil.test", "https://up.qiniu.com:444/", "https://user:pass@up.qiniu.com/"]) {
    assert.throws(() => imageUploadHost(policy([url])), /存储地址/);
  }
});

test("upload verifies storage and CDN separately without forwarding account headers or following redirects", async () => {
  const bytes = await png();
  for (const readable of [true, false, true]) {
    let calls = 0;
    const result = await uploadImage(async (url, init) => {
      calls++;
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).has("utoken"), false);
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      if (String(url).startsWith("https://upload.qiniup.com")) {
        const form = init!.body as FormData;
        const content = Buffer.from(await (form.get("file") as Blob).arrayBuffer());
        assert.deepEqual(content, bytes);
        return Response.json({ key: form.get("key"), hash: imageEtag(content) });
      }
      assert.match(String(url), /^https:\/\/billimg\.qianjiapp\.com\/[a-f0-9]{32}!huge$/);
      return readable ? new Response(bytes, { headers: { "content-type": "image/png" } }) : new Response("unavailable", { status: 503 });
    }, "fixture-uid", bytes, policy(["https://up.qiniu.com"]));
    assert.equal(calls, 2);
    assert.equal(result.storageVerified, true);
    assert.equal(result.fileVerified, readable);
    assert.equal(result.pixelsVerified, readable);
  }
  await assert.rejects(uploadImage(async () => Response.json({key: "wrong", hash: "wrong"}), "fixture-uid", bytes, policy(["https://up.qiniu.com"])), /存储回执/);
});

test("attachment append preserves old images and all bill fields, replacement clears only when explicit", async t => {
  const root = mkdtempSync(join(tmpdir(), "qianji-attachment-"));
  const store = new Store(":memory:");
  t.after(() => { store.close(); rmSync(root, {recursive: true}); });
  const pat = store.createPat("fixture", null), account = store.bindPat(pat.id, "uid", "token", "device");
  const now = Date.now();
  store.setUserCache(account.id, {id: account.uid, viptype: -1, __baseCurrency: "CNY"}, now);
  store.setCatalogCache(account.id, "books", "", [{bookid: "1", name: "fixture", visible: 1, userid: "uid"}], now);
  let row: Record<string, unknown> = { id: "170000000000000001", bookid: "1", userid: "uid", type: 0, money: 3, time: 1700000000, createtime: 1700000000, updatetime: 1700000000, cateid: "2", assetid: "3", remark: "preserve", images: ["old-image"], extra: {flag: 3} };
  let writes = 0;
  const client = new QianjiClient({fetch: async (url, init) => {
    if (new URL(String(url)).pathname === "/bill/syncall") {
      writes++;
      const payload = parseQianjiJson(new URLSearchParams(String(init!.body)).get("v")!) as {bills: {changelist: Record<string, unknown>[]}};
      row = payload.bills.changelist[0]!;
      return Response.json({ec: 200, data: {sync_result: {bill: {new_ids: [], update_ids: ["170000000000000001"], del_ids: [], conf_ids: [], has_failed: false}}}});
    }
    assert.equal(new URL(String(url)).pathname, "/syncv2/pull");
    return Response.json({ec: 200, data: {changes: [row], deletes: [], categories: [], bookid: -1, pageoffset: 0, hasmore: 0, pagesign: "", lasttimes: {cursor: writes}}});
  }});
  await new OperationJournal(root).execute("uid", "image", "upload_bill_image", {}, async () => {}, async () => ({content: [], structuredContent: {image: {imageKey: "new-image", storageVerified: true, pixelsVerified: true}}}));
  const service = new MoneyTrackService(store, client, () => now, {operationsRoot: root});
  const added = await service.setBillImages(account.id, {billId: "170000000000000001", mode: "append", uploadRequestIds: ["image"]});
  assert.deepEqual(added.imageUrls, ["https://billimg.qianjiapp.com/old-image!webporigin", "https://billimg.qianjiapp.com/new-image!webporigin"]);
  assert.equal(added.money, 3); assert.equal(added.remark, "preserve"); assert.equal(added.time, 1700000000);
  await service.setBillImages(account.id, {billId: "170000000000000001", mode: "append", uploadRequestIds: ["image"]});
  assert.equal(writes, 1);
  await assert.rejects(service.setBillImages(account.id, {billId: "170000000000000001", mode: "append", uploadRequestIds: ["foreign"]}), /本账号/);
  const cleared = await service.setBillImages(account.id, {billId: "170000000000000001", mode: "replace", uploadRequestIds: []});
  assert.deepEqual(cleared.imageUrls, []); assert.equal(writes, 2);
});
