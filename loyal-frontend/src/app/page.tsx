import { Desktop } from "@/components/os/Desktop";

/**
 * The home route is a windowed shell rather than a document.
 *
 * The content did not change — the dictionary entry, the commitment axis, the
 * chain ledger and the small print are all still here. What changed is that
 * they stopped being sections of a page you scroll past in a fixed order and
 * became panels you open, move and close. A reader who only wants the offer can
 * close everything else; one who wants the argument can lay all five out at
 * once. A scroll can only ever be read in the order it was written.
 *
 * Everything below 1024px falls back to a stack, because a floating desktop on
 * a phone is a diorama. See `Desktop` for how the shell avoids simply being
 * Windows 98 in neon.
 */
export default function Page() {
  return <Desktop />;
}
