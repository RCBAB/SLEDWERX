import { beforeEach, describe, expect, it, vi } from "vitest";

// addSuspensionPhotos talks to two server actions, the image resizer and the
// browser storage client. All four are replaced here so the order of steps,
// the retry and the cleanup can be checked without a network.
const actions = vi.hoisted(() => ({
  prepareSuspensionPhotos: vi.fn(),
  addSuspensionPhoto: vi.fn(),
}));
const storage = vi.hoisted(() => ({
  upload: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/app/garage/suspension-actions", () => actions);
vi.mock("@/lib/sleds/photo-upload", () => {
  class PhotoError extends Error {}
  return {
    PhotoError,
    resizePhoto: vi.fn(async (file: File) => {
      if (!file.type.startsWith("image/")) throw new PhotoError("Choose an image file, such as a JPEG or PNG.");
      return new Blob(["jpeg"], { type: "image/jpeg" });
    }),
  };
});
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ storage: { from: () => storage } }),
}));

import { addSuspensionPhotos } from "./photo-upload";

const SLED = "11111111-1111-4111-8111-111111111111";
const REVISION = { kind: "revision" as const, id: "22222222-2222-4222-8222-222222222222" };
const photo = (name = "a.png", type = "image/png") => new File(["x"], name, { type });

/** Owners and editors may remove files; mechanics may not (storage policy). */
const owner = { room: 6, canRemoveFiles: true };
const mechanic = { room: 6, canRemoveFiles: false };

const uploadedPaths = () => storage.upload.mock.calls.map(([path]) => path as string);

beforeEach(() => {
  vi.clearAllMocks();
  storage.upload.mockResolvedValue({ error: null });
  storage.remove.mockResolvedValue({ data: [], error: null });
  actions.addSuspensionPhoto.mockResolvedValue({ ok: true });
});

describe("addSuspensionPhotos", () => {
  it("checks first, then uploads and records each photo in its parent's folder", async () => {
    actions.prepareSuspensionPhotos.mockResolvedValue({ ...owner, room: 4 });
    const result = await addSuspensionPhotos(SLED, REVISION, [photo("1.png"), photo("2.png")]);
    expect(result).toEqual({ added: 2, error: null, leftover: 0 });
    expect(actions.prepareSuspensionPhotos).toHaveBeenCalledBefore(storage.upload);
    expect(uploadedPaths()).toHaveLength(2);
    for (const path of uploadedPaths()) expect(path).toMatch(new RegExp(`^${SLED}/${REVISION.id}/[0-9a-f-]{36}\\.jpg$`));
    // Positions continue after the 2 photos already there.
    expect(actions.addSuspensionPhoto.mock.calls.map((c) => c[3])).toEqual([2, 3]);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("uploads nothing when the server check refuses (parent removed, no permission)", async () => {
    actions.prepareSuspensionPhotos.mockResolvedValue({
      error: "This was removed meanwhile. Reload the page and try again.",
      room: 0,
      canRemoveFiles: false,
    });
    const result = await addSuspensionPhotos(SLED, REVISION, [photo()]);
    expect(result).toEqual({ added: 0, error: "This was removed meanwhile. Reload the page and try again.", leftover: 0 });
    expect(storage.upload).not.toHaveBeenCalled();
    expect(actions.addSuspensionPhoto).not.toHaveBeenCalled();
  });

  it("never uploads files that don't fit or aren't images", async () => {
    actions.prepareSuspensionPhotos.mockResolvedValue({ ...owner, room: 1 });
    const result = await addSuspensionPhotos(SLED, REVISION, [photo("1.png"), photo("2.png"), photo("3.png")]);
    expect(result.added).toBe(1);
    expect(result.error).toBe("Only 1 more photo fit here (6 at most); 2 weren't added.");
    expect(storage.upload).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    actions.prepareSuspensionPhotos.mockResolvedValue(owner);
    const notImage = await addSuspensionPhotos(SLED, REVISION, [photo("notes.txt", "text/plain")]);
    expect(notImage).toEqual({ added: 0, error: "Choose an image file, such as a JPEG or PNG.", leftover: 0 });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("doesn't save a record when the upload itself fails", async () => {
    actions.prepareSuspensionPhotos.mockResolvedValue(owner);
    storage.upload.mockResolvedValue({ error: { message: "network" } });
    const result = await addSuspensionPhotos(SLED, REVISION, [photo()]);
    expect(result).toEqual({ added: 0, error: "A photo couldn't be uploaded. Please try again.", leftover: 0 });
    expect(actions.addSuspensionPhoto).not.toHaveBeenCalled();
  });

  it("retries a failed record save once, with the same path", async () => {
    actions.prepareSuspensionPhotos.mockResolvedValue(mechanic);
    actions.addSuspensionPhoto
      .mockResolvedValueOnce({ error: "Something went wrong. Please try again." })
      .mockResolvedValueOnce({ ok: true });
    const result = await addSuspensionPhotos(SLED, REVISION, [photo()]);
    expect(result).toEqual({ added: 1, error: null, leftover: 0 });
    expect(actions.addSuspensionPhoto).toHaveBeenCalledTimes(2);
    expect(actions.addSuspensionPhoto.mock.calls[0][2]).toBe(actions.addSuspensionPhoto.mock.calls[1][2]);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("treats a retry that finds the record already saved as success", async () => {
    actions.prepareSuspensionPhotos.mockResolvedValue(mechanic);
    actions.addSuspensionPhoto
      .mockResolvedValueOnce({ error: "Something went wrong. Please try again." })
      .mockResolvedValueOnce({ error: "That was already saved." });
    const result = await addSuspensionPhotos(SLED, REVISION, [photo()]);
    expect(result).toEqual({ added: 1, error: null, leftover: 0 });
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("doesn't retry refusals that can't change (limit reached, parent removed)", async () => {
    actions.prepareSuspensionPhotos.mockResolvedValue(owner);
    actions.addSuspensionPhoto.mockResolvedValue({ error: "At most 6 photos can be added here." });
    await addSuspensionPhotos(SLED, REVISION, [photo()]);
    expect(actions.addSuspensionPhoto).toHaveBeenCalledTimes(1);
  });

  it("owner/editor: when the record can't be saved, the uploaded file is removed again", async () => {
    actions.prepareSuspensionPhotos.mockResolvedValue(owner);
    actions.addSuspensionPhoto.mockResolvedValue({ error: "Something went wrong. Please try again." });
    const result = await addSuspensionPhotos(SLED, REVISION, [photo(), photo("not-tried.png")]);
    expect(actions.addSuspensionPhoto).toHaveBeenCalledTimes(2); // first save + one retry
    expect(storage.remove).toHaveBeenCalledWith([uploadedPaths()[0]]);
    expect(result).toEqual({ added: 0, error: "Something went wrong. Please try again.", leftover: 0 });
    // It stops there: the next photo isn't uploaded.
    expect(storage.upload).toHaveBeenCalledTimes(1);
  });

  it("owner/editor: a refused record (no retry) also has its file removed", async () => {
    actions.prepareSuspensionPhotos.mockResolvedValue(owner);
    actions.addSuspensionPhoto.mockResolvedValue({ error: "Restore it before adding photos." });
    const result = await addSuspensionPhotos(SLED, REVISION, [photo()]);
    expect(storage.remove).toHaveBeenCalledWith([uploadedPaths()[0]]);
    expect(result.leftover).toBe(0);
  });

  it("mechanic: after both saves fail the file can't be removed; it's counted as left over (Migration 8 cleanup)", async () => {
    actions.prepareSuspensionPhotos.mockResolvedValue(mechanic);
    actions.addSuspensionPhoto.mockResolvedValue({ error: "Something went wrong. Please try again." });
    const result = await addSuspensionPhotos(SLED, REVISION, [photo()]);
    expect(actions.addSuspensionPhoto).toHaveBeenCalledTimes(2);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(result).toEqual({ added: 0, error: "Something went wrong. Please try again.", leftover: 1 });
  });

  it("keeps the photos saved before a failure", async () => {
    actions.prepareSuspensionPhotos.mockResolvedValue(mechanic);
    actions.addSuspensionPhoto.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ error: "At most 6 photos can be added here." });
    const result = await addSuspensionPhotos(SLED, REVISION, [photo("1.png"), photo("2.png")]);
    expect(result).toEqual({ added: 1, error: "At most 6 photos can be added here.", leftover: 1 });
  });
});
