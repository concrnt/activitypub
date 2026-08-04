import { configure, defaultConsoleFormatter, getConsoleSink, type LogRecord } from "@logtape/logtape";
import { AsyncLocalStorage } from "node:async_hooks";
import { inspect } from "node:util";

// defaultConsoleFormatterはmessage埋め込み値しか出力せずpropertiesを捨てるため、
// fedifyが構造化プロパティで渡す情報(署名検証失敗のreason/keyId等)を末尾に追記する
const formatter = (record: LogRecord): readonly unknown[] => {
  const args = defaultConsoleFormatter(record);
  if (Object.keys(record.properties).length === 0) return args;
  return [...args, inspect(record.properties, { depth: 4, breakLength: Infinity, compact: true })];
};

await configure({
  contextLocalStorage: new AsyncLocalStorage(),
  sinks: {
    console: getConsoleSink({ formatter }),
  },
  filters: {},
  loggers: [
    {
      category: "activitypub",
      lowestLevel: "debug",
      sinks: ["console"],
    },
    { category: "fedify", lowestLevel: "info", sinks: ["console"] },
    // parentSinks: "override"がないと親fedifyのsinkにも流れてinfo以上が二重出力される
    { category: ["fedify", "sig"], lowestLevel: "debug", sinks: ["console"], parentSinks: "override" },
    {
      category: ["logtape", "meta"],
      lowestLevel: "warning",
      sinks: ["console"],
    },
  ],
});
