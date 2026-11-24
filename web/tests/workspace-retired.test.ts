import { describe, expect, it, vi } from "vitest";

// The deferred jobs pages, retired (P61-e9): their old addresses answer a temporary redirect, before any page
// renders, with a relative `Location` (as `/documents` does): the list to the Agenda, a job to the agenda item its
// fold entry names (the folded-job lookup), and a job no entry names, or a lookup that fails, to the Agenda.

const PROJECT = "3f9c2a10-6d4e-4b8a-9f1e-2c7d5b8a0e41";
const AGENDA = `/projects/${PROJECT}/workspace`;

const session = vi.hoisted(() => ({ token: "t" as string | null }));
vi.mock("@/lib/session", () => ({
  openSession: (value: string | undefined) => (value ? session.token : null),
  readSessionCookie: (req: Request) =>
    req.headers.get("cookie") ? "sealed" : undefined,
}));
const reads = vi.hoisted(() => ({ readFoldedJob: vi.fn() }));
vi.mock("@/lib/workspace/read", () => reads);

const List =
  await import("@/app/(app)/projects/[projectId]/workspace/deferred/route");
const Job =
  await import("@/app/(app)/projects/[projectId]/workspace/deferred/[job]/route");

const signedIn = (path: string) =>
  new Request(`http://internal:3030${path}`, {
    headers: { cookie: "kb_session=sealed" },
  });

async function job(id: string, req = signedIn(`${AGENDA}/deferred/${id}`)) {
  return Job.GET(req, {
    params: Promise.resolve({ projectId: PROJECT, job: id }),
  });
}

describe("the retired deferred pages", () => {
  it("sends the list to the Agenda, temporarily, relative", async () => {
    const res = await List.GET(signedIn(`${AGENDA}/deferred?page=2`), {
      params: Promise.resolve({ projectId: PROJECT }),
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(AGENDA);
  });

  it("sends a folded job to the item its fold entry names", async () => {
    reads.readFoldedJob.mockResolvedValueOnce({
      state: "ready",
      value: { agenda: "A2-k5" },
    });
    const res = await job("D31-x9");
    expect(reads.readFoldedJob).toHaveBeenCalledWith("t", PROJECT, "D31-x9");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${AGENDA}/agenda/A2-k5`);
  });

  it("sends a job no entry names (a 404), or a failed lookup, to the Agenda", async () => {
    reads.readFoldedJob.mockResolvedValueOnce({ state: "not-found" });
    expect((await job("D77-zz")).headers.get("location")).toBe(AGENDA);
    reads.readFoldedJob.mockResolvedValueOnce({ state: "error", status: 503 });
    expect((await job("D20-a3")).headers.get("location")).toBe(AGENDA);
    reads.readFoldedJob.mockRejectedValueOnce(new Error("socket hang up"));
    const res = await job("D21-b4");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(AGENDA);
  });

  it("sends a signed-out reader to sign in, and back to the job's address", async () => {
    const res = await job(
      "D31-x9",
      new Request(`http://internal:3030${AGENDA}/deferred/D31-x9`),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      `/login?next=${encodeURIComponent(`${AGENDA}/deferred/D31-x9`)}`,
    );
  });
});
