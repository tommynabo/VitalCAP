import { getAccountListPage } from "@/lib/data/repository";
import { AccountsClient } from "./accounts-client";

export default async function AccountsPage() {
  const initialPage = await getAccountListPage();
  return <AccountsClient initialPage={initialPage} />;
}

