import { validateCandidate } from "./frozen-protocol-candidate-rules.js";
import { requiredFixtureNames } from "./frozen-protocol-fixture-cases.js";
import { isRecord, readString } from "./frozen-protocol-validation-primitives.js";

type FixtureManifest = {
  readonly profiles: ReadonlySet<string>;
  readonly records: readonly Record<string, unknown>[];
};

export type ValidationReport = {
  readonly accepted: readonly string[];
  readonly errors: readonly string[];
  readonly rejected: readonly string[];
};

export function validateSkwProtocolFixtureManifest(value: unknown): ValidationReport {
  const errors: string[] = [];
  const rejected: string[] = [];
  const manifest = parseManifest(value, errors);
  if (!manifest) {
    return { accepted: [], errors, rejected };
  }

  const accepted = manifest.records.flatMap((record) => validateRecord(record, manifest.profiles));
  const acceptedNames = new Set(accepted);
  for (const requiredName of requiredFixtureNames) {
    if (!acceptedNames.has(requiredName)) {
      errors.push(`missing fixture case ${requiredName}`);
    }
  }
  for (const record of manifest.records) {
    const name = readString(record, "name");
    if (!name?.startsWith("reject-")) {
      continue;
    }
    const rejectionErrors = validateCandidate(record, manifest.profiles);
    if (rejectionErrors.length === 0) {
      errors.push(`${name}: rejected fixture was accepted`);
      continue;
    }
    rejected.push(name);
  }
  return { accepted, errors, rejected };
}

function parseManifest(value: unknown, errors: string[]): FixtureManifest | null {
  if (!isRecord(value)) {
    errors.push("fixture manifest is not an object");
    return null;
  }
  const profiles = value.profiles;
  if (!Array.isArray(profiles) || !profiles.every((profile) => typeof profile === "string")) {
    errors.push("fixture manifest profiles must be strings");
    return null;
  }
  const records = value.fixtures;
  if (!Array.isArray(records) || !records.every(isRecord)) {
    errors.push("fixture manifest fixtures must be objects");
    return null;
  }
  return { profiles: new Set(profiles), records };
}

function validateRecord(record: Record<string, unknown>, profiles: ReadonlySet<string>): string[] {
  const name = readString(record, "name");
  if (!name) {
    return [];
  }
  if (name.startsWith("reject-")) {
    return validateCandidate(record, profiles).length > 0 ? [name] : [];
  }
  return validateCandidate(record, profiles).length === 0 ? [name] : [];
}
