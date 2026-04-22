export type ToolExecutionStatus = "completed" | "blocked" | "failed" | "pending";

export interface ToolPayload {
  summary: string;
  detail: string;
}

export interface ToolExecutionResult<TToolName extends string = string> {
  handled: true;
  kind: "result";
  toolName: TToolName;
  status: "completed";
  payload: ToolPayload;
  output: string;
}

export interface ToolExecutionError<TToolName extends string = string, TErrorCode extends string = string> {
  handled: true;
  kind: "error";
  toolName: TToolName;
  status: Exclude<ToolExecutionStatus, "completed">;
  errorCode: TErrorCode;
  payload: ToolPayload;
  output: string;
}

export interface ToolUnhandledResult {
  handled: false;
  output: string;
}

export type ToolExecutionOutcome<
  TToolName extends string = string,
  TErrorCode extends string = string
> = ToolExecutionResult<TToolName> | ToolExecutionError<TToolName, TErrorCode> | ToolUnhandledResult;

export function isHandledToolExecutionOutcome<
  TToolName extends string,
  TErrorCode extends string
>(
  result: ToolExecutionOutcome<TToolName, TErrorCode>
): result is ToolExecutionResult<TToolName> | ToolExecutionError<TToolName, TErrorCode> {
  return result.handled;
}

export function buildToolSuccessResult<TToolName extends string>(
  toolName: TToolName,
  summary: string,
  detail: string
): ToolExecutionResult<TToolName> {
  return {
    handled: true,
    kind: "result",
    toolName,
    status: "completed",
    payload: {
      summary,
      detail
    },
    output: [summary, detail].filter(Boolean).join("\n\n")
  };
}

export function buildToolErrorResult<TToolName extends string, TErrorCode extends string>(
  toolName: TToolName,
  status: Exclude<ToolExecutionStatus, "completed">,
  errorCode: TErrorCode,
  summary: string,
  detail: string
): ToolExecutionError<TToolName, TErrorCode> {
  return {
    handled: true,
    kind: "error",
    toolName,
    status,
    errorCode,
    payload: {
      summary,
      detail
    },
    output: [summary, detail].filter(Boolean).join("\n\n")
  };
}
