'use client';

/**
 * The credential vault's field grid.
 *
 * A client component for one reason: § 1812.528's inspection record is mandatory for a
 * nursing licence and meaningless for anything else, so the two fields have to appear
 * and disappear with the credential type the operator has picked. Showing them always
 * would ask for an inspection of a TB clearance; hiding them always is what made this
 * form unable to record an RN or LVN licence at all.
 *
 * Everything here is presentation. The rule itself lives in lib/domain/licenceInspection
 * and is enforced again in the query layer, so a form that got this wrong would be
 * refused rather than obeyed.
 */
import { useState } from 'react';
import { LABEL } from '@h-hallows/core/domain';
import type { CredentialType } from '@h-hallows/core/schema';
import { requiresInspection } from '@/lib/domain/licenceInspection';

export function CredentialVaultFields({
  allTypes, required, defaultType, todayISO,
}: {
  allTypes: readonly CredentialType[];
  required: CredentialType[];
  defaultType: CredentialType;
  todayISO: string;
}) {
  const [type, setType] = useState<CredentialType>(defaultType);
  const inspect = requiresInspection(type);

  return (
    <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <label className="label" htmlFor="type">Credential</label>
        <select
          id="type"
          name="type"
          className="select"
          required
          value={type}
          onChange={(e) => setType(e.target.value as CredentialType)}
        >
          {allTypes.map((t) => (
            <option key={t} value={t}>
              {LABEL[t]}{required.includes(t) ? ' (required)' : ''}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="expiresOn">Expires</label>
        <input id="expiresOn" name="expiresOn" type="date" className="input" />
        <p className="mt-1 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
          Leave blank if it does not expire.
        </p>
      </div>
      <div>
        <label className="label" htmlFor="verifiedOn">Verified on</label>
        <input id="verifiedOn" name="verifiedOn" type="date" className="input"
          required defaultValue={todayISO} />
      </div>
      <div>
        <label className="label" htmlFor="verificationSource">Verified how</label>
        <input id="verificationSource" name="verificationSource" className="input"
          required placeholder="BRN license verification" />
      </div>
      <div>
        <label className="label" htmlFor="identifier">Identifier</label>
        <input id="identifier" name="identifier" className="input" placeholder="Optional" />
      </div>
      <div>
        <label className="label" htmlFor="issuedOn">Issued</label>
        <input id="issuedOn" name="issuedOn" type="date" className="input" />
      </div>

      {inspect ? (
        <>
          <div>
            <label className="label" htmlFor="inspectedExpiryNoted">
              Expiry on the licence
            </label>
            <input id="inspectedExpiryNoted" name="inspectedExpiryNoted" type="date"
              className="input" required />
            <p className="mt-1 text-[0.6875rem]" style={{ color: 'var(--ink-faint)' }}>
              § 1812.528 — the date printed on the licence you inspected, which is a
              separate record from the source lookup above.
            </p>
          </div>
          <div>
            <label className="label" htmlFor="inspectedOn">Inspected on</label>
            <input id="inspectedOn" name="inspectedOn" type="date" className="input"
              defaultValue={todayISO} />
          </div>
        </>
      ) : null}

      <div className="sm:col-span-2">
        <label className="label" htmlFor="notes">Note</label>
        <input id="notes" name="notes" className="input" placeholder="Optional" />
      </div>
    </div>
  );
}
