import LocationCapture from "./LocationCapture";

export default function LocationPage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const raw = searchParams.contact_id;
  const contactId = typeof raw === "string" ? raw : "";

  return <LocationCapture contactId={contactId} />;
}
