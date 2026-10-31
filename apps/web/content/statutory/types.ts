/** Shared shape for every statutory document. */
export interface StatutoryText {
  /** Bumped whenever the wording changes. Stored on every delivered document. */
  readonly VERSION: string;
  readonly LAST_REVIEWED: string;
  /**
   * `statute` — reproduced verbatim; nobody may edit it.
   * `approved` — drafted to a statutory requirement and signed off by counsel.
   * `draft`    — drafted to a statutory requirement, NOT yet approved. Blocks delivery.
   * `unfilled` — the content is a business fact nobody has supplied yet.
   */
  readonly status: 'statute' | 'approved' | 'draft' | 'unfilled';
  readonly citation: string;
  /** When and to whom it is delivered. Never shown to anyone. */
  readonly purpose: string;
  readonly text: string;
}

/** Deliverable means: it exists, and someone with authority stands behind it. */
export function isDeliverable(t: StatutoryText): boolean {
  return (t.status === 'statute' || t.status === 'approved') && t.text.trim().length > 0;
}
