import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ApprovalCard from "./ApprovalCard";
import { useApprovalsStore } from "@/store/approvals";

vi.mock("@/api/endpoints", () => ({
  sendMessage: vi.fn(async () => ({ accepted: true })),
}));

import { sendMessage } from "@/api/endpoints";

describe("ApprovalCard", () => {
  beforeEach(() => {
    useApprovalsStore.getState().clear("s1");
    vi.mocked(sendMessage).mockClear();
  });

  const approval = {
    id: "ap-1",
    toolName: "bash",
    detail: "rm -rf /tmp/x",
    reason: "destructive command",
    queuePosition: 1,
    totalPending: 1,
  };

  it("渲染 toolName + detail + reason", () => {
    render(
      <ApprovalCard sessionId="s1" approval={approval} onError={() => undefined} />
    );
    expect(screen.getByText(/待审批：bash/)).toBeInTheDocument();
    expect(screen.getByText(/destructive command/)).toBeInTheDocument();
    expect(screen.getByText(/rm -rf/)).toBeInTheDocument();
  });

  it("点 Approve 发 /approve <id>", async () => {
    render(
      <ApprovalCard sessionId="s1" approval={approval} onError={() => undefined} />
    );
    fireEvent.click(screen.getByText(/✓ Approve/));
    expect(sendMessage).toHaveBeenCalledWith("s1", "/approve ap-1");
  });

  it("点 Deny 发 /deny <id>", async () => {
    render(
      <ApprovalCard sessionId="s1" approval={approval} onError={() => undefined} />
    );
    fireEvent.click(screen.getByText(/✗ Deny/));
    expect(sendMessage).toHaveBeenCalledWith("s1", "/deny ap-1");
  });
});
