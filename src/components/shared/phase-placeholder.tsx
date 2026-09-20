import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Shared placeholder for pages whose real implementation belongs to a later
 * phase (Prompts 1–6). Keeps every nav destination navigable and on-brand
 * in Phase 0 without faking functionality that hasn't been built yet.
 */
export function PhasePlaceholder({
  title,
  phase,
  description,
  children,
}: {
  title: string;
  phase: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <Badge variant="primary">{phase}</Badge>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-text-muted">{description}</p>
        </CardContent>
      </Card>
      {children}
    </div>
  );
}
