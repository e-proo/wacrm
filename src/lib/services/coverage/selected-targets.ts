/**
 * Explicit Coverage recipient selection. These are account-scoped CRM contact
 * IDs, never raw phone numbers and never model-generated outreach targets.
 *
 * Existing `selectedContactId` tasks remain readable. New multi-recipient
 * tasks use `selectedContactIds`; both representations must never coexist.
 */
export const MAX_EXPLICIT_COVERAGE_CONTACTS = 20
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const has = (object: Readonly<Record<string, unknown>>, name: string) =>
  Object.prototype.hasOwnProperty.call(object, name)

export function parseExplicitCoverageContactIds(
  policy: Readonly<Record<string, unknown>>,
): readonly string[] | null {
  const single = has(policy, 'selectedContactId')
  const multiple = has(policy, 'selectedContactIds')
  if (single && multiple) {
    throw new Error('COVERAGE_SELECTED_CONTACT_MODES_CONFLICT')
  }
  if (!single && !multiple) return null
  const ids = single ? [policy.selectedContactId] : policy.selectedContactIds
  if (!Array.isArray(ids) || ids.length < 1 ||
      ids.length > MAX_EXPLICIT_COVERAGE_CONTACTS ||
      !ids.every(id => typeof id === 'string' && UUID_RE.test(id)) ||
      new Set(ids).size !== ids.length) {
    throw new Error('COVERAGE_SELECTED_CONTACTS_INVALID')
  }
  return [...ids] as string[]
}

export function normalizeExplicitCoverageContactIds(input: {
  selectedContactId?: unknown
  selectedContactIds?: unknown
}): readonly string[] | null {
  const selectedContactId = input.selectedContactId
  const selectedContactIds = input.selectedContactIds
  if ((selectedContactId === undefined || selectedContactId === null) &&
      (selectedContactIds === undefined || selectedContactIds === null)) return null
  if (selectedContactId != null && selectedContactIds != null) {
    throw new Error('COVERAGE_SELECTED_CONTACT_MODES_CONFLICT')
  }
  return parseExplicitCoverageContactIds(
    selectedContactIds != null
      ? { selectedContactIds }
      : { selectedContactId },
  )
}

export function sameExplicitCoverageContacts(
  left: readonly string[] | null,
  right: readonly string[] | null,
): boolean {
  if (left === null || right === null) return left === right
  return left.length === right.length && left.every((id,index) => id === right[index])
}
