import { getLogger } from "@logtape/logtape";
import { PrometheusExporter, PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import { MeterProvider } from "@opentelemetry/sdk-metrics";

const logger = getLogger("activitypub");

// fedify組み込みのOpenTelemetryメトリクス(配送/inbox/署名検証/キュー深さ等)をPrometheus形式で
// 公開するための受け皿。createFederationへmeterProviderとして明示注入する(globalの登録順に依存しない)。
// exporter自身のHTTPサーバは起動せず、Hono側の /metrics で配信する。
// target_info / otel_scope_* はconcrnt本体(Go)のメトリクス流儀に合わせて省く
const exporter = new PrometheusExporter({
    preventServerStart: true,
    withoutTargetInfo: true,
    withoutScopeInfo: true,
});
const serializer = new PrometheusSerializer(undefined, false, undefined, true, true);

export const meterProvider = new MeterProvider({ readers: [exporter] });

export const renderPrometheus = async (): Promise<string> => {
    const { resourceMetrics, errors } = await exporter.collect();
    for (const error of errors) {
        logger.warn(`Metrics collection error: ${error}`);
    }
    return serializer.serialize(resourceMetrics);
};
