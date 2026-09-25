import { getAccountBundles } from "@/lib/data/repository";
import { AccountsClient } from "./accounts-client";

export default async function AccountsPage() {
  const accountBundles = await getAccountBundles();
  return <AccountsClient accountBundles={accountBundles} />;
}

