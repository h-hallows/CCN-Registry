import { requireOperator } from '@/lib/operator';
import { listPartners } from '@/lib/queries/partners';
import { portalUsersForMany } from '@/lib/domain/portalAccess';
import { addPartnerAction } from '@/app/(app)/actions';
import { ActionForm, Disclose } from '@/components/ActionForm';
import { PortalAccess } from '@/components/PortalAccess';
import { Empty, Section, shortDate } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Who sends work here, and who can sign in on their behalf.
 *
 * NOTHING ON THIS SCREEN IS MONEY. Civil Code § 1812.531 forbids a nurses' registry from
 * splitting a fee with anyone, and whether a partner may be compensated at all is open
 * with counsel. So this shows a name, a way to reach them, and what they sent — and no
 * amount, rate, share or balance. A field for one does not belong here.
 */
export default async function PartnersPage() {
  const { ctx } = await requireOperator();
  const partners = await listPartners(ctx);

  // One read for every partner's accounts, not one per partner.
  const usersByPartner = await portalUsersForMany(
    ctx, 'partner', partners.map((p) => p.id));
  const withUsers = partners.map((p) => ({
    partner: p,
    users: usersByPartner.get(p.id) ?? [],
  }));

  const sent = partners.reduce((n, p) => n + p.sent, 0);
  const became = partners.reduce((n, p) => n + p.became, 0);

  return (
    <>
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Referral partners</h1>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
          {partners.length} on the list ·{' '}
          <span className="nums">{sent}</span> families sent ·{' '}
          <span className="nums">{became}</span> became a household
        </p>
      </div>

      {partners.length === 0 ? (
        <Section title="Nobody on the list">
          <Empty>
            Add the discharge planners, care managers and attorneys who send families
            here. Their own screen lets them send one without the family filling in a form.
          </Empty>
        </Section>
      ) : null}

      {withUsers.map(({ partner: p, users }) => (
        <Section
          key={p.id}
          title={p.org ? `${p.name} — ${p.org}` : p.name}
          blurb={[
            p.role,
            `${p.sent} sent`,
            `${p.became} became a household`,
            p.lastSentAt ? `last ${shortDate(p.lastSentAt)}` : 'nothing yet',
          ].filter(Boolean).join(' · ')}
        >
          <div className="divide-y hair-soft">
            <div className="px-4 py-3 text-sm" style={{ color: 'var(--ink-soft)' }}>
              {[p.phone, p.email].filter(Boolean).join(' · ') || 'No contact recorded.'}
              {p.notes ? (
                <p className="mt-1 text-xs" style={{ color: 'var(--ink-faint)' }}>{p.notes}</p>
              ) : null}
            </div>
            <div>
              <PortalAccess
                kind="partner"
                subjectId={p.id}
                users={users}
                defaultName={p.name}
              />
            </div>
          </div>
        </Section>
      ))}

      <Section
        title="Add a partner"
        blurb="A name, where they work and how to reach them. There is no money on this screen: § 1812.531 forbids splitting a fee, and what a partner may be compensated for is open with counsel."
      >
        <div className="px-4 py-4">
          <Disclose summary="Add someone who sends families here">
            <ActionForm action={addPartnerAction} submitLabel="Add them" resetOnSuccess>
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <label className="label" htmlFor="partner-name">Their name</label>
                  <input id="partner-name" name="name" className="input" required />
                </div>
                <div>
                  <label className="label" htmlFor="partner-org">Where they work</label>
                  <input id="partner-org" name="org" className="input" placeholder="Optional" />
                </div>
                <div>
                  <label className="label" htmlFor="partner-role">What they do</label>
                  <input id="partner-role" name="role" className="input"
                    placeholder="Discharge planner, attorney…" />
                </div>
                <div>
                  <label className="label" htmlFor="partner-phone">Phone</label>
                  <input id="partner-phone" name="phone" className="input" placeholder="Optional" />
                </div>
                <div>
                  <label className="label" htmlFor="partner-email">Email</label>
                  <input id="partner-email" name="email" type="email" className="input"
                    placeholder="Optional" />
                </div>
                <div className="sm:col-span-2 lg:col-span-1">
                  <label className="label" htmlFor="partner-notes">Note</label>
                  <input id="partner-notes" name="notes" className="input"
                    placeholder="How you know them" />
                </div>
              </div>
            </ActionForm>
          </Disclose>
        </div>
      </Section>
    </>
  );
}
