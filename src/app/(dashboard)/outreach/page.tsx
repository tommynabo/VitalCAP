import { getOutreachDashboardData } from "@/lib/data/repository";
import { OutreachClient } from "./outreach-client";

export default async function OutreachPage() {
  const initialData = await getOutreachDashboardData();

  return <OutreachClient initialData={initialData} />;
}

