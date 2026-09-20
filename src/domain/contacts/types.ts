/**
 * Domain types for `contacts` (people/roles) and `contact_points` (channel
 * endpoints). See Prompt 1 §1.1 and §1.5–1.6 for scoring/verification rules.
 * A single account can legitimately have several non-duplicate contact
 * points (owner email, purchasing email, generic info@, phone, ...).
 */

export type RoleType =
  | "owner"
  | "titular_pharmacist"
  | "manager"
  | "purchasing_manager"
  | "buyer"
  | "employee"
  | "generic_role"
  | "unknown";

export type Seniority = "owner" | "senior" | "mid" | "junior" | "unknown";

export type ContactStatus = "active" | "needs_review" | "archived";

export interface Contact {
  id: string;
  workspaceId: string;
  accountId: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  jobTitle: string | null;
  roleType: RoleType;
  isDecisionMaker: boolean;
  seniority: Seniority;
  linkedinUrl: string | null;
  sourceConfidence: number;
  status: ContactStatus;
  createdAt: string;
  updatedAt: string;
}

export type ContactPointType = "email" | "phone" | "linkedin" | "other";

export type VerificationStatus =
  | "unverified"
  | "valid"
  | "catch_all"
  | "risky"
  | "invalid"
  | "unknown"
  | "disposable"
  | "bounced";

/**
 * Channel eligibility is deliberately separate from "endpoint exists" — see
 * Prompt 0 §0.9. Discovering an email/phone is not permission to send to it.
 */
export type ChannelEligibilityStatus =
  | "unknown"
  | "professional_contact"
  | "eligible_email"
  | "eligible_sms"
  | "eligible_call"
  | "consented_email"
  | "consented_sms"
  | "prior_relationship"
  | "opted_out"
  | "blocked";

export type ContactPointStatus =
  | "discovered"
  | "normalized"
  | "unverified"
  | "valid"
  | "catch_all"
  | "risky"
  | "invalid"
  | "eligible"
  | "ineligible"
  | "selected"
  | "queued"
  | "contacted";

export interface ContactPoint {
  id: string;
  workspaceId: string;
  accountId: string;
  contactId: string | null;
  type: ContactPointType;
  value: string;
  normalizedValue: string;
  label: string | null;
  isGeneric: boolean;
  isPersonalOrNamed: boolean;
  priorityScore: number;
  verificationStatus: VerificationStatus;
  verificationProvider: string | null;
  verificationCheckedAt: string | null;
  channelEligibility: ChannelEligibilityStatus;
  sourceUrl: string | null;
  sourceType: string | null;
  lastContactedAt: string | null;
  status: ContactPointStatus;
  createdAt: string;
  updatedAt: string;
}
