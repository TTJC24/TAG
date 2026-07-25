export interface TraceContext {
  traceId: string;
  requestId: string;
  organizationId?: string;
  workflowId?: string;
  agentRunId?: string;
  sourceRecordIds: readonly string[];
}

export interface SafeLogEvent {
  level: "debug" | "info" | "warn" | "error";
  name: string;
  message: string;
  context: TraceContext;
  attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface Telemetry {
  log(event: SafeLogEvent): void;
  count(name: string, value: number, attributes?: Record<string, string>): void;
  duration(
    name: string,
    milliseconds: number,
    attributes?: Record<string, string>,
  ): void;
}

export class JsonConsoleTelemetry implements Telemetry {
  log(event: SafeLogEvent): void {
    const sink =
      event.level === "error"
        ? console.error
        : event.level === "warn"
          ? console.warn
          : console.log;
    sink(JSON.stringify({ timestamp: new Date().toISOString(), ...event }));
  }

  count(
    name: string,
    value: number,
    attributes: Record<string, string> = {},
  ): void {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        metric: name,
        kind: "count",
        value,
        attributes,
      }),
    );
  }

  duration(
    name: string,
    milliseconds: number,
    attributes: Record<string, string> = {},
  ): void {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        metric: name,
        kind: "duration_ms",
        value: milliseconds,
        attributes,
      }),
    );
  }
}
