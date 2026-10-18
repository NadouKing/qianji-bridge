"""Read exported payment files locally with Python 3's standard library. Never writes."""
import csv
import datetime as dt
import decimal
import hashlib
import io
import json
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

MAX_BYTES = 64 * 1024 * 1024
NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def xlsx_tables(path):
    with zipfile.ZipFile(path) as archive:
        if sum(x.file_size for x in archive.infolist()) > MAX_BYTES:
            raise ValueError("Workbook expanded size exceeds limit")
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            for item in ET.fromstring(archive.read("xl/sharedStrings.xml")).findall("s:si", NS):
                shared.append("".join(t.text or "" for t in item.findall(".//s:t", NS)))
        rels = {r.attrib["Id"]: r.attrib["Target"] for r in
                ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))}
        sheets = ET.fromstring(archive.read("xl/workbook.xml")).findall("s:sheets/s:sheet", NS)
        for sheet in sheets:
            rid = sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]
            target = rels[rid]
            name = target.lstrip("/") if target.startswith("/") else posixpath.normpath("xl/" + target)
            rows = []
            for row in ET.fromstring(archive.read(name)).findall("s:sheetData/s:row", NS):
                cells = {}
                for cell in row.findall("s:c", NS):
                    col = re.match(r"[A-Z]+", cell.attrib["r"]).group()
                    index = 0
                    for char in col:
                        index = index * 26 + ord(char) - 64
                    if index > 64:
                        continue
                    value = cell.findtext("s:v", default="", namespaces=NS)
                    if cell.attrib.get("t") == "s":
                        value = shared[int(value)]
                    elif cell.attrib.get("t") == "inlineStr":
                        value = "".join(t.text or "" for t in cell.findall(".//s:t", NS))
                    cells[index - 1] = value
                rows.append((int(row.attrib["r"]), [cells.get(i, "") for i in range(max(cells, default=-1) + 1)]))
            yield rows


def tables(path):
    if path.stat().st_size > MAX_BYTES:
        raise ValueError("Input file exceeds limit")
    if path.suffix.lower() == ".xlsx":
        yield from xlsx_tables(path)
    elif path.suffix.lower() == ".csv":
        raw = path.read_bytes()
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = raw.decode("gb18030")
        yield list(enumerate(csv.reader(io.StringIO(text)), 1))
    else:
        raise ValueError("Only .xlsx and .csv exports are supported")


def clean(value):
    return str(value).strip().lstrip("\ufeff")


def parse(path):
    candidates = []
    for rows in tables(path):
        for i, (row_number, values) in enumerate(rows):
            header = [clean(x) for x in values]
            if "交易时间" in header and "交易对方" in header and "收/支" in header:
                source = "alipay" if "交易订单号" in header else "wechat"
                required = ["交易时间", "交易对方", "收/支",
                            "交易订单号" if source == "alipay" else "交易单号"]
                if not all(x in header for x in required):
                    raise ValueError("Payment header is missing required columns")
                candidates.append((source, header, rows[i + 1:]))
                break
    if len(candidates) != 1:
        raise ValueError("Expected exactly one payment table")
    source, header, rows = candidates[0]
    result, seen = [], set()
    for row_number, values in rows:
        data = dict(zip(header, [clean(x) for x in values]))
        date_text = data.get("交易时间", "")
        if not date_text or not (re.match(r"^\d{4}[-/]\d{2}[-/]\d{2}", date_text) or
                                 re.match(r"^\d{5}(\.\d+)?$", date_text)):
            if data.get("交易订单号", data.get("交易单号", "")).isdigit():
                raise ValueError("Invalid transaction date at source row " + str(row_number))
            continue
        if re.match(r"^\d{5}(\.\d+)?$", date_text):
            date = dt.datetime(1899, 12, 30) + dt.timedelta(days=float(date_text))
        else:
            date = dt.datetime.fromisoformat(date_text.replace("/", "-"))
        if date.tzinfo is None:
            date = date.replace(tzinfo=dt.timezone(dt.timedelta(hours=8)))
        amount_text = data.get("金额", data.get("金额(元)", data.get("金额（元）", "")))
        amount = decimal.Decimal(re.sub(r"[¥￥,\s]", "", amount_text)) * 100
        if not amount.is_finite() or amount != amount.to_integral_value() or amount < 0:
            raise ValueError("Invalid cent amount at source row " + str(row_number))
        record = {
            "source": source, "sourceRow": row_number,
            "orderId": data.get("交易订单号", data.get("交易单号", "")),
            "time": int(date.timestamp()), "merchant": data["交易对方"],
            "item": data.get("商品说明", data.get("商品", "")),
            "direction": data["收/支"], "amountMinor": int(amount), "currency": "CNY",
            "paymentMethod": data.get("收/付款方式", data.get("支付方式", "")),
            "status": data.get("交易状态", data.get("当前状态", "")),
            "kind": data.get("交易分类", data.get("交易类型", "")),
            "note": data.get("备注", ""),
        }
        record["id"] = source + ":" + (record["orderId"] or hashlib.sha256(
            json.dumps(record, ensure_ascii=False, sort_keys=True).encode()).hexdigest())
        if record["id"] in seen:
            raise ValueError("Duplicate transaction at source row " + str(row_number))
        seen.add(record["id"])
        result.append(record)
    if not result:
        raise ValueError("No transactions found")
    return {"version": 1, "source": source, "records": result}


if __name__ == "__main__":
    try:
        print(json.dumps(parse(Path(sys.argv[1])), ensure_ascii=False))
    except Exception as error:
        # Avoid printing source contents, file paths or transaction identifiers.
        print(type(error).__name__ + ": unable to parse payment export", file=sys.stderr)
        sys.exit(1)
