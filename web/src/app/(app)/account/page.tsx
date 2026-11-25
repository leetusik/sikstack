import type { Metadata } from "next";

import { ACCOUNT } from "@/content/account";
import { requireIdentity } from "@/lib/auth-guards";
import { BlockText, Panel, PanelBody, PanelHead, Stack } from "@/sikstack/ui";

import { PasswordPanel } from "./password-panel";

/**
 * Account (`/account`, P78, F10): a system page in the Shell, reached from the account menu. Built on the settled
 * look without a design round, in the org home's panel pattern: the account's Email, then Password (Change, given the
 * current one, through the BFF route `/api/auth/password`, which keeps this session and ends the others).
 */
export const metadata: Metadata = { title: ACCOUNT.title };

export default async function AccountPage() {
  const { identity } = await requireIdentity();
  return (
    <div className="column">
      <header className="page-top">
        <div className="page-head">
          <div className="page-title">
            <h1>{ACCOUNT.title}</h1>
          </div>
        </div>
      </header>
      <Stack gap={5}>
        <Panel aria-label={ACCOUNT.email.heading}>
          <PanelHead>
            <h2>{ACCOUNT.email.heading}</h2>
          </PanelHead>
          <PanelBody rule>
            <BlockText>
              <span className="strong" style={{ overflowWrap: "anywhere" }}>
                {identity.user.email}
              </span>
            </BlockText>
          </PanelBody>
        </Panel>
        <PasswordPanel />
      </Stack>
    </div>
  );
}
