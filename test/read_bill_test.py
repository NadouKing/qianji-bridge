"""Offline fixtures only. Run with python -B -m unittest discover -s test -p read_bill_test.py."""
import csv
import importlib.util
import io
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("read_bill", Path(__file__).parents[1] / "scripts" / "read-bill.py")
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


class ReaderTests(unittest.TestCase):
    def csv_file(self, folder, encoding="gb18030", duplicate=False, amount="3.21"):
        out = io.StringIO(newline="")
        writer = csv.writer(out)
        writer.writerow(["Export explanation"])
        writer.writerow(["交易时间", "交易分类", "交易对方", "商品说明", "收/支", "金额", "收/付款方式", "交易状态", "交易订单号"])
        row = ["2024-01-02 08:00:00", "其他", "Fixture公司", "含逗号,和\n换行", "支出", amount, "Fixture银行卡", "交易成功", "fixture-order"]
        writer.writerow(row)
        if duplicate:
            writer.writerow(row)
        path = Path(folder) / "fixture.csv"
        path.write_bytes(out.getvalue().encode(encoding))
        return path

    def test_csv_encoding_quotes_and_cent_precision(self):
        with tempfile.TemporaryDirectory() as folder:
            data = reader.parse(self.csv_file(folder))
            row = data["records"][0]
            self.assertEqual(row["amountMinor"], 321)
            self.assertEqual(row["item"], "含逗号,和\n换行")
            self.assertEqual(row["time"], 1704153600)
            self.assertEqual(row["sourceRow"], 3)
            self.assertEqual(reader.parse(self.csv_file(folder, "utf-8-sig"))["records"], data["records"])

    def test_duplicate_and_invalid_precision_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                reader.parse(self.csv_file(folder, duplicate=True))
            with self.assertRaisesRegex(ValueError, "cent"):
                reader.parse(self.csv_file(folder, amount="3.211"))

    def test_xlsx_sheet_relationships_shared_strings_and_source_rows(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "fixture.xlsx"
            values = ["交易时间", "交易对方", "收/支", "金额(元)", "交易单号", "支付方式", "当前状态",
                      "2024-01-02 08:00:00", "Fixture公司", "支出", "3.21", "fixture-order", "Fixture银行卡", "支付成功"]
            shared = '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + "".join(
                "<si><t>" + value + "</t></si>" for value in values) + "</sst>"
            rows = ""
            for number, offset in [(5, 0), (6, 7)]:
                rows += '<row r="' + str(number) + '">' + "".join(
                    '<c r="' + chr(65 + i) + str(number) + '" t="s"><v>' + str(offset + i) + "</v></c>"
                    for i in range(7)) + "</row>"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Fixture" r:id="rId1"/></sheets></workbook>')
                archive.writestr("xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="rId1" Target="worksheets/custom.xml"/></Relationships>')
                archive.writestr("xl/sharedStrings.xml", shared)
                archive.writestr("xl/worksheets/custom.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + rows + "</sheetData></worksheet>")
            row = reader.parse(path)["records"][0]
            self.assertEqual(row["source"], "wechat")
            self.assertEqual(row["sourceRow"], 6)
            self.assertEqual(row["amountMinor"], 321)

    def test_missing_header_and_nonfinite_money_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "empty.csv"
            path.write_text("not a payment export", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "exactly one"):
                reader.parse(path)
            for value in ["NaN", "Infinity", "-1"]:
                with self.assertRaises(ValueError):
                    reader.parse(self.csv_file(folder, amount=value))


if __name__ == "__main__":
    unittest.main()
