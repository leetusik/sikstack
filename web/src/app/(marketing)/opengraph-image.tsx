import { SHARE_IMAGE_ALT, SHARE_IMAGE_SIZE, shareImage } from "./share-image";

// The landing's `og:image` (P78, F9): the picture is `./share-image.tsx`'s.
export const alt = SHARE_IMAGE_ALT;
export const size = SHARE_IMAGE_SIZE;
export const contentType = "image/png";

export default function OpenGraphImage() {
  return shareImage();
}
