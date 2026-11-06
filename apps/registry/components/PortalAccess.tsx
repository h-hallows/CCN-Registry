import { ActionForm, Disclose } from '@/components/ActionForm';
import {
  grantAccessAction, reissueLinkAction, restoreAccessAction, revokeAccessAction,
} from '@/app/(app)/actions';
import { Empty, shortDate, shortDateTime } from '@/components/ui';
import type { PortalSubjectKind, PortalUser } from '@/lib/domain/portalAccess';

const WORDING: Record<PortalSubjectKind, { who: string; what: string }> = {
  household: { who: 'the family', what: 'their own screen' },
  provider: { who: 'this provider', what: 'their own screen' },
  partner: { who: 'this contact', what: 'the referral screen' },
};

/**
 * Who can sign in on behalf of one household, provider or partner.
 *
 * The portals have no sign-up of any kind: an address reaches one only because it was
 * given access here. That makes this screen the whole of the access control, which is
 * why each refusal is spelled out rather than silently corrected — one address holds one
 * role, one address belongs to one household, and a revoked account is restored
 * deliberately rather than by being re-invited.
 *
 * There is no mail provider, so the link appears once, on this screen, for the operator
 * to send. It is never written to the log.
 */
export function PortalAccess({
  kind, subjectId, users, defaultName,
}: {
  kind: PortalSubjectKind;
  subjectId: string;
  users: PortalUser[];
  defaultName?: string;
}) {
  const w = WORDING[kind];

  return (
    <div className="divide-y hair-soft">
      {users.length === 0 ? (
        <div className="px-4 py-4">
          <Empty>
            Nobody can sign in for {w.who} yet, so {w.what} is unreachable. There is no
            sign-up: an address gets in only from here.
          </Empty>
        </div>
      ) : (
        <ul className="divide-y hair-soft">
          {users.map((u) => (
            <li key={u.userId} className="px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="text-sm font-medium">{u.displayName}</span>
                  <span className="ml-2 text-xs" style={{ color: 'var(--ink-soft)' }}>
                    {u.email}
                  </span>
                </div>
                <span className="text-xs" style={{
                  color: u.disabledAt ? 'var(--color-expired)' : 'var(--ink-faint)',
                }}>
                  {u.disabledAt
                    ? `revoked ${shortDate(u.disabledAt)}`
                    : u.lastSeenAt
                      ? `last seen ${shortDateTime(u.lastSeenAt)}`
                      : u.liveInviteExpiresAt
                        ? `link live until ${shortDate(u.liveInviteExpiresAt)}`
                        : 'never signed in, no live link'}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
                {u.disabledAt ? (
                  <Disclose summary="Restore this account" tone="quiet">
                    <ActionForm action={restoreAccessAction} submitLabel="Restore it">
                      <input type="hidden" name="kind" value={kind} />
                      <input type="hidden" name="subjectId" value={subjectId} />
                      <input type="hidden" name="userId" value={u.userId} />
                      <label className="label" htmlFor={`restore-${u.userId}`}>Why</label>
                      <input id={`restore-${u.userId}`} name="reason" className="input"
                        required placeholder="What changed" />
                    </ActionForm>
                  </Disclose>
                ) : (
                  <>
                    <Disclose summary="Issue a new sign-in link" tone="quiet">
                      <ActionForm action={reissueLinkAction} submitLabel="Issue a link">
                        <input type="hidden" name="userId" value={u.userId} />
                        <p className="text-[0.6875rem] leading-relaxed"
                          style={{ color: 'var(--ink-faint)' }}>
                          Any link already outstanding stops working. Useful when one was
                          forwarded to the wrong address.
                        </p>
                      </ActionForm>
                    </Disclose>
                    <Disclose summary="Withdraw access" tone="quiet">
                      <ActionForm
                        action={revokeAccessAction}
                        submitLabel="Withdraw it"
                        confirm="This disables the account, deletes any open session and kills any outstanding link. Continue?"
                      >
                        <input type="hidden" name="kind" value={kind} />
                        <input type="hidden" name="subjectId" value={subjectId} />
                        <input type="hidden" name="userId" value={u.userId} />
                        <label className="label" htmlFor={`revoke-${u.userId}`}>Why</label>
                        <input id={`revoke-${u.userId}`} name="reason" className="input"
                          required placeholder="Record why" />
                        <p className="mt-2 text-[0.6875rem] leading-relaxed"
                          style={{ color: 'var(--ink-faint)' }}>
                          The account and the record of who held it are kept. Who could see
                          this information, and when, is part of the record.
                        </p>
                      </ActionForm>
                    </Disclose>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="px-4 py-4">
        <ActionForm action={grantAccessAction} submitLabel="Give access and issue a link">
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="subjectId" value={subjectId} />
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor={`name-${subjectId}`}>Their name</label>
              <input id={`name-${subjectId}`} name="displayName" className="input" required
                defaultValue={defaultName} />
            </div>
            <div>
              <label className="label" htmlFor={`email-${subjectId}`}>Their email</label>
              <input id={`email-${subjectId}`} name="email" type="email" className="input"
                required placeholder="name@example.com" />
            </div>
          </div>
          <p className="mt-3 text-[0.6875rem] leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
            The link works once and lasts seven days. It appears here for you to send —
            nothing is emailed, and it is not written to any log. One address holds one
            role and belongs to one {kind}; anything else is refused and says why.
          </p>
        </ActionForm>
      </div>
    </div>
  );
}
