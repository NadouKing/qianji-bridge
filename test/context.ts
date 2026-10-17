import { test as bunTest } from "bun:test";

type Cleanup = () => void | Promise<void>;

interface TestContext {
  after(cleanup: Cleanup): void;
}

/** Runs a Bun test and executes registered cleanup callbacks in reverse order. */
export default function test(name: string, body: (context: TestContext) => void | Promise<void>): void {
  bunTest(name, async () => {
    const cleanups: Cleanup[] = [];
    try {
      await body({ after: (cleanup) => cleanups.push(cleanup) });
    } finally {
      for (let index = cleanups.length - 1; index >= 0; index -= 1) {
        // Bun 的临时 SQLite statement 可能延后释放句柄；Windows 不允许删除仍打开的文件。
        if (process.platform === "win32") Bun.gc(true);
        await cleanups[index]!();
      }
    }
  });
}
