import assert from "node:assert/strict";

import { AppError } from "../src/errors.ts";
import { publicBill } from "../src/qianji-mappers.ts";
import test from "./context.ts";

const baseBill = {
  id: "1770000000000123456", bookid: 1, time: 1_770_000_000,
  type: 0, money: 10, remark: "fixture", cateid: 2, assetid: -1,
  createtime: 1_770_000_000, userid: "fixture-user",
};

test("完整账单按附件顺序返回普通图和高清图的 HTTPS 地址", () => {
  const images = ["receipt-fixture", "receipt-fixture_hg", "receipt-fixture"];
  assert.deepEqual(publicBill({ ...baseBill, images }).imageUrls, [
    "https://billimg.qianjiapp.com/receipt-fixture!webporigin",
    "https://billimg.qianjiapp.com/receipt-fixture_hg!huge",
    "https://billimg.qianjiapp.com/receipt-fixture!webporigin",
  ]);
  assert.deepEqual(images, ["receipt-fixture", "receipt-fixture_hg", "receipt-fixture"]);
});

test("缺省、null 和空附件列表均返回空地址数组", () => {
  assert.deepEqual(publicBill(baseBill).imageUrls, []);
  for (const images of [null, []]) {
    assert.deepEqual(publicBill({ ...baseBill, images }).imageUrls, []);
  }
});

test("图片对象键编码为固定 CDN 下的单个路径段，不可注入域名或查询参数", () => {
  for (const key of ["https://example.invalid/a?secret=value#fragment", "../fixture", "图片 fixture_hg"]) {
    const [url] = publicBill({ ...baseBill, images: [key] }).imageUrls as string[];
    const parsed = new URL(url!);
    assert.equal(parsed.origin, "https://billimg.qianjiapp.com");
    assert.equal(parsed.search, "");
    assert.equal(parsed.hash, "");
    assert.equal(parsed.pathname.split("/").length, 2);
    assert.equal(decodeURIComponent(parsed.pathname.slice(1)), `${key}${key.endsWith("_hg") ? "!huge" : "!webporigin"}`);
  }
});

test("无效附件结构返回受控错误，不暴露原始图片信息", () => {
  for (const images of ["private-key", {}, [null], [1], [{}], [""], ["  "], ["\ud800"]]) {
    assert.throws(() => publicBill({ ...baseBill, images }),
      (error) => error instanceof AppError && error.code === "QIANJI_RESPONSE_INVALID" && !error.message.includes("private-key"));
  }
});
