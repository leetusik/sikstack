import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The feedback control (job 08, round 01-landing-diagram-feedback, signed: `## Build` §2, 3c-3d, §5):
// its states as pure steps, its markup rendered to static HTML, and its two mounts. The suite has no
// DOM, so the native dialog's own behaviour (showModal, close, focus return) is S6's and S7's, in a
// real browser.

const calls: string[] = [];

vi.mock("next/server", async (importOriginal) => {
  const real = await importOriginal<typeof import("next/server")>();
  return {
    ...real,
    connection: vi.fn(async () => {
      calls.push("connection");
    }),
  };
});

const identity = {
  user: { id: 7, email: "june@example.com" },
  tenant: { name: "Fieldnotes", slug: null },
};
vi.mock("@/lib/auth-guards", () => ({
  requireIdentity: vi.fn(async () => ({ token: "t", identity })),
  requireSession: vi.fn(async () => "t"),
}));

import { SEND_FEEDBACK } from "@/content/send-feedback";
import {
  answerForm,
  canClose,
  closeForm,
  editForm,
  initialFeedbackForm,
  noticeText,
  openForm,
  showCount,
  submitForm,
  type FeedbackForm,
} from "@/sikstack/send-feedback/model";
import { FeedbackDialogContent } from "@/sikstack/send-feedback/send-feedback";
import { Landing } from "@/sikstack/landing/landing";

const KEY = "SIKSTACK_FEEDBACK_CAPTURE_KEY";
const LIMIT = 2000;
const TRIGGER =
  /<button[^>]*aria-haspopup="dialog"[^>]*>Send feedback<\/button>/g;

function triggers(html: string): string[] {
  return html.match(TRIGGER) ?? [];
}

function form(partial: Partial<FeedbackForm>): FeedbackForm {
  return { ...initialFeedbackForm, ...partial };
}

function dialog(
  context: "visitor" | "account",
  partial: Partial<FeedbackForm> = {},
): string {
  return renderToStaticMarkup(
    createElement(FeedbackDialogContent, {
      context,
      limit: LIMIT,
      account: context === "account" ? "june@example.com" : undefined,
      form: form({ phase: "open", ...partial }),
      uid: "sf",
    }),
  );
}

describe("the control's states (§2's table)", () => {
  it("checks only on Send, never while typing", () => {
    let f = openForm(initialFeedbackForm);
    f = editForm(f, "message", "   ");
    f = editForm(f, "email", "not an address");
    expect(f.phase).toBe("open");
    expect(f.errors).toEqual({});
    f = submitForm(f, "visitor", LIMIT);
    expect(f.phase).toBe("invalid");
    expect(f.errors).toEqual({ message: "empty", email: "not-one" });
  });

  it("drops a field's mark when it is edited, and is plain again once none is left", () => {
    let f = submitForm(
      form({ phase: "open", message: "", email: "a@b" }),
      "visitor",
      LIMIT,
    );
    f = editForm(f, "message", "Hello");
    expect(f).toMatchObject({ phase: "invalid", errors: { email: "not-one" } });
    f = editForm(f, "email", "a@b.co");
    expect(f).toMatchObject({ phase: "open", errors: {} });
  });

  it("ignores Escape while sending, and keeps the send", () => {
    const sending = submitForm(
      form({ phase: "open", message: "Hello" }),
      "visitor",
      LIMIT,
    );
    expect(sending.phase).toBe("sending");
    expect(canClose(sending)).toBe(false);
    expect(closeForm(sending)).toBe(sending);
  });

  it("keeps what was typed on Cancel and Escape; Done empties the form", () => {
    const typed = form({ phase: "failed", message: "Hello", email: "a@b.co" });
    const closed = closeForm(typed);
    expect(closed).toMatchObject({
      phase: "closed",
      message: "Hello",
      email: "a@b.co",
    });
    expect(openForm(closed)).toMatchObject({ phase: "open", message: "Hello" });
    expect(closeForm(form({ phase: "sent", message: "Hello" }))).toEqual(
      initialFeedbackForm,
    );
  });

  it("maps each answer to its phase; a signed-in user has no refused-site", () => {
    const sending = form({ phase: "sending", message: "Hello" });
    expect(answerForm(sending, "visitor", { status: "sent" }).phase).toBe(
      "sent",
    );
    expect(answerForm(sending, "visitor", { status: "failed" }).phase).toBe(
      "failed",
    );
    expect(
      answerForm(sending, "visitor", { status: "refused-site" }).phase,
    ).toBe("refused-site");
    expect(
      answerForm(sending, "account", { status: "refused-site" }).phase,
    ).toBe("refused");
    expect(
      answerForm(sending, "visitor", {
        status: "invalid",
        field: "message",
        reason: "too-long",
      }),
    ).toMatchObject({ phase: "invalid", errors: { message: "too-long" } });
    // an answer lands only on a send still in flight
    const open = form({ phase: "open" });
    expect(answerForm(open, "visitor", { status: "sent" })).toBe(open);
  });

  it("says the visitor's refusal 'from here' and the account's 'for now'", () => {
    expect(noticeText("refused", "visitor")).toBe(SEND_FEEDBACK.refusedVisitor);
    expect(noticeText("refused", "account")).toBe(SEND_FEEDBACK.refusedAccount);
    expect(noticeText("refused-site", "account")).toBe(
      SEND_FEEDBACK.refusedAccount,
    );
  });

  it("shows the count from nine tenths of the limit, in the record's format", () => {
    expect(showCount("x".repeat(1799), LIMIT)).toBe(false);
    expect(showCount("x".repeat(1800), LIMIT)).toBe(true);
    expect(SEND_FEEDBACK.count(1923, LIMIT)).toBe("1,923 of 2,000 characters");
    expect(SEND_FEEDBACK.messageLong(LIMIT)).toBe(
      "Messages must be 2,000 characters or fewer.",
    );
  });
});

describe("the dialog's form", () => {
  it("gives a visitor the hidden website trap: out of the tab order and unannounced", () => {
    const html = dialog("visitor");
    const trap =
      /<div class="sf-hp" aria-hidden="true"><input([^>]*)\/?><\/div>/.exec(
        html,
      );
    expect(trap).not.toBeNull();
    expect(trap![1]).toContain('name="website"');
    expect(trap![1]).toContain('tabindex="-1"');
    expect(trap![1]).toMatch(/autocomplete="off"/i);
    // after every real control, so the modal never focuses it first
    expect(html.indexOf('name="website"')).toBeGreaterThan(
      html.indexOf('type="submit"'),
    );
    expect(html).toContain(`>${SEND_FEEDBACK.email}</label>`);
  });

  it("never gives a signed-in user an email field, and says who sends", () => {
    const html = dialog("account");
    expect(html).not.toMatch(/type="email"|name="website"/);
    expect(html).not.toContain(SEND_FEEDBACK.email);
    expect(html).toContain(
      `<p class="dim">${SEND_FEEDBACK.sendsAs("june@example.com")}</p>`,
    );
  });

  it("marks an invalid field and describes it by its sentence", () => {
    const html = dialog("visitor", {
      phase: "invalid",
      errors: { message: "empty" },
    });
    expect(html).toMatch(/aria-invalid="true" aria-describedby="sf-msg-err"/);
    expect(html).toContain(
      `<p class="field-error" id="sf-msg-err">${SEND_FEEDBACK.messageEmpty}</p>`,
    );
  });

  it("disables the fields and Cancel while sending, Send reading Sending…", () => {
    const html = dialog("visitor", { phase: "sending", message: "Hi" });
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toMatch(
      /<button type="button" class="btn" disabled="">Cancel/,
    );
    expect(html).toContain('data-busy="true"');
  });

  it("gives way to the sent view, Done described by the two lines", () => {
    const html = dialog("visitor", { phase: "sent", email: " r@example.com " });
    expect(html).toContain(SEND_FEEDBACK.sentReply("r@example.com"));
    expect(html).toContain('aria-describedby="sf-sent sf-sent-text"');
    expect(dialog("visitor", { phase: "sent" })).toContain(
      `>${SEND_FEEDBACK.sentPlain}<`,
    );
  });
});

describe("the two mounts", () => {
  const saved = process.env[KEY];
  beforeEach(() => {
    calls.length = 0;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("the landing's footer holds the trigger only when given the control", () => {
    const without = renderToStaticMarkup(createElement(Landing));
    expect(triggers(without)).toEqual([]);
    expect(without).toContain('<div class="split lp-foot-row"><nav');
    const withIt = renderToStaticMarkup(
      createElement(Landing, { sendFeedback: { limit: LIMIT } }),
    );
    const foot = withIt.slice(withIt.indexOf("<footer"));
    expect(triggers(foot)).toEqual([
      '<button type="button" class="lp-link lp-foot-send" aria-haspopup="dialog">Send feedback</button>',
    ]);
    // P87: and a second trigger under the open-source section's Contribute, on the same condition
    const contribute = withIt.slice(
      withIt.indexOf('id="open-source"'),
      withIt.indexOf("<footer"),
    );
    expect(triggers(contribute)).toEqual([
      '<button type="button" class="link link-row" aria-haspopup="dialog">Send feedback</button>',
    ]);
    expect(triggers(withIt)).toHaveLength(2);
  });

  it("the landing page reads the key per request, after connection()", async () => {
    const { default: LandingPage } = await import("@/app/(marketing)/page");
    delete process.env[KEY];
    const off = renderToStaticMarkup(await LandingPage());
    expect(triggers(off)).toEqual([]);
    expect(off).not.toMatch(/Send feedback|sf-dlg|lp-foot-send/);
    process.env[KEY] = "vk_test";
    const on = renderToStaticMarkup(await LandingPage());
    // the footer's and (P87) the open-source section's
    expect(triggers(on)).toHaveLength(2);
    expect(calls).toEqual(["connection", "connection"]);
  });

  it("org home's loading head shows the account's trigger only with the key", async () => {
    const { default: DashboardLoading } =
      await import("@/app/(app)/dashboard/loading");
    delete process.env[KEY];
    const off = renderToStaticMarkup(await DashboardLoading());
    expect(triggers(off)).toEqual([]);
    process.env[KEY] = "vk_test";
    const on = renderToStaticMarkup(await DashboardLoading());
    const head = on.slice(on.indexOf('<div class="page-head">'));
    expect(head).toMatch(
      /^<div class="page-head"><div class="page-title"><h1>Fieldnotes<\/h1><\/div><button type="button" class="btn" aria-haspopup="dialog">Send feedback<\/button>/,
    );
    expect(triggers(on)).toHaveLength(1);
  });

  it("org home's head shows the account's trigger only with the key", () => {
    // The loaded page reads six API calls; its head's source is held to the loading head's.
    const page = readFileSync(
      join(__dirname, "../src/app/(app)/dashboard/page.tsx"),
      "utf8",
    );
    expect(page).toMatch(
      /<h1>\{orgName\}<\/h1>\s*<\/div>\s*\{feedback\.configured \? \(\s*<SendFeedback\s*context="account"\s*limit=\{feedback\.limit\}\s*account=\{identity\.user\.email\}\s*triggerClassName="btn"\s*\/>\s*\) : null\}\s*<\/div>/,
    );
    expect(page).toContain("const feedback = feedbackControl();");
  });
});

describe("the control's sources", () => {
  const dir = join(__dirname, "../src/sikstack/send-feedback");
  const files = readdirSync(dir).map((f) => ({
    name: f,
    text: readFileSync(join(dir, f), "utf8"),
  }));
  const code = files.filter((f) => f.name.endsWith(".tsx"));

  it("write every visible string in the content module only", () => {
    const words = Object.values(SEND_FEEDBACK).filter(
      (v) => typeof v === "string",
    ) as string[];
    for (const { name, text } of code)
      for (const w of words)
        expect(
          text.includes(`"${w}"`) || text.includes(`>${w}<`),
          `${name}: ${w}`,
        ).toBe(false);
    for (const { name, text } of code)
      expect(
        />\s*[A-Za-z][^<>{}]*<\//.test(
          text.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ""),
        ),
        name,
      ).toBe(false);
  });

  it("use no toast and add no token", () => {
    for (const { name, text } of files) {
      expect(
        /toast/i.test(text.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")),
        name,
      ).toBe(false);
      if (name.endsWith(".css"))
        expect(text.match(/--[\w-]+\s*:/g), name).toBeNull();
    }
  });
});
