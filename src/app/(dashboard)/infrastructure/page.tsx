import { PhasePlaceholder } from "@/components/shared/phase-placeholder";

export default function InfrastructurePage() {
  return (
    <PhasePlaceholder
      title="Infrastructure"
      phase="Prompt 3"
      description="Domains, mailboxes, email/SMS/verification/search/LLM provider status and webhook health are implemented in Phase 3. No secret values are ever displayed after save."
    />
  );
}
