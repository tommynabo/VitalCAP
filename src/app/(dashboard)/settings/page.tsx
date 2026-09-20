import { PhasePlaceholder } from "@/components/shared/phase-placeholder";

export default function SettingsPage() {
  return (
    <PhasePlaceholder
      title="Settings"
      phase="Cross-phase"
      description="Workspace, user and offer/commercial-fact configuration (Prompt 1 §offers) is introduced as each phase needs it. No commercial facts, prices, margins or booking URLs are hard-coded anywhere in this codebase — they live here instead."
    />
  );
}
