import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { hashInviteToken } from "@/lib/auth/invitations";
import { __resetRateLimitForTests } from "@/lib/rate-limit";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/lib/automations/admin-client", () => ({
  supabaseAdmin: () => ({ rpc }),
}));

function peek(token: string) {
  return GET(
    new Request("https://staging.example.test/api/invitations/peek", {
      headers: { "x-forwarded-for": "198.51.100.29" },
    }),
    { params: Promise.resolve({ token }) },
  );
}

describe("public invitation peek privileged boundary", () => {
  beforeEach(() => {
    rpc.mockReset();
    __resetRateLimitForTests();
  });

  it("delegates only a SHA-256 token hash to the server-only RPC", async () => {
    const token = "test-invite-token";
    const data = {
      ok: true,
      account_name: "Test account",
      role: "agent",
      expires_at: "2026-12-01T00:00:00Z",
    };
    rpc.mockResolvedValue({ data, error: null });

    const response = await peek(token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(data);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("peek_invitation", {
      p_token_hash: hashInviteToken(token),
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(token);
  });

  it("rejects missing tokens without invoking the privileged RPC", async () => {
    const response = await peek("");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, reason: "not_found" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("keeps internal RPC errors out of public responses", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "private database detail" } });
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await peek("valid-token");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ ok: false, reason: "server_error" });
    } finally {
      logger.mockRestore();
    }
  });
});
