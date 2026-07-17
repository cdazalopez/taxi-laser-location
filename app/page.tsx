import { redirect } from "next/navigation";

export default function Home({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const contactId = searchParams.contact_id;
  const qs =
    typeof contactId === "string" && contactId.length > 0
      ? `?contact_id=${encodeURIComponent(contactId)}`
      : "";
  redirect(`/location${qs}`);
}
