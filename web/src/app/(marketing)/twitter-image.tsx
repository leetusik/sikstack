import { SHARE_IMAGE_ALT, SHARE_IMAGE_SIZE, shareImage } from "./share-image";

// The landing's `twitter:image` (P78, F9): the same picture as `og:image`, `./share-image.tsx`'s.
export const alt = SHARE_IMAGE_ALT;
export const size = SHARE_IMAGE_SIZE;
export const contentType = "image/png";

export default function TwitterImage() {
  return shareImage();
}
