import { AppError, type InvokeGrant } from "@claudius/shared";

/**
 * The server-side half of the image policy (Phase 12).
 *
 * Both the cap and the resolution target are advisory to the client and
 * authoritative here. The client enforces them because that is where it can do
 * so cheaply — refusing a fourth attachment before an upload is spent, resizing
 * before the bytes cross the wire — but none of that is trusted. This function
 * is what actually decides.
 */
export function assertImagesAllowed(
  imageCount: number,
  grant: InvokeGrant,
): void {
  // No policy for the role means no image service at all, which is how the guest
  // tier is configured off. Note that guests never reach here in practice: they
  // are already blocked at the blob token, the record creation, and the parse
  // step. This is the fourth wall, not the first.
  if (!grant.imagePolicy) {
    throw new AppError(
      "model_not_permitted",
      "Image attachments aren't available on your plan.",
    );
  }

  // A model without vision plus an attached image is a REJECTED turn, not a
  // dropped image. The user picked this model; tell them it cannot see.
  if (!grant.supportsImages) {
    throw new AppError(
      "model_not_permitted",
      `${grant.displayName} can't read images. Switch to a model with vision to ask about this attachment.`,
    );
  }

  const { maxPerTurn, enforcement } = grant.imagePolicy;
  if (imageCount > maxPerTurn && enforcement === "hard") {
    throw new AppError(
      "invalid_input",
      `You can attach up to ${maxPerTurn} image${maxPerTurn === 1 ? "" : "s"} per message.`,
    );
  }
  // "warn" deliberately falls through: the composer already showed the cost, and
  // the point of the soft cap is that it can be exceeded on purpose.
}

/**
 * The text of the human turn as it will be PERSISTED — the user's words plus a
 * note naming the images, since the images themselves are gone the moment the
 * run ends.
 *
 * Without this a thread reads incoherently on reload: an answer describing a
 * photo, attached to a question that never mentions one, or (on an image-only
 * turn) attached to nothing at all. The note is what a later turn, a later model
 * call, and the user scrolling back all read instead of the pixels.
 */
export function attachedImagesTurnText(
  text: string,
  filenames: string[],
): string {
  const list = filenames.join(", ");
  const note = `[attached image${filenames.length === 1 ? "" : "s"}: ${list}]`;
  return text.trim().length > 0 ? `${text}\n\n${note}` : note;
}
