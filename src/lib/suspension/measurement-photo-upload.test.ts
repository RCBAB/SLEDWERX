import { beforeEach, describe, expect, it, vi } from "vitest";

// saveMeasurementPhoto talks to three server actions, the image resizer and the
// browser storage client; all are replaced so the steps can be checked offline.
const actions = vi.hoisted(() => ({ prepareMeasurementPhoto: vi.fn(), addMeasurementPhoto: vi.fn(), replaceMeasurementPhoto: vi.fn() }));
const storage = vi.hoisted(() => ({ upload: vi.fn(), remove: vi.fn() }));

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
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ storage: { from: () => storage } }) }));

import { saveMeasurementPhoto } from "./measurement-photo-upload";

const target = {
  sledId: "11111111-1111-4111-8111-111111111111",
  revisionId: "22222222-2222-4222-8222-222222222222",
  settingId: "33333333-3333-4333-8333-333333333333",
};
const photo = (name = "a.png", type = "image/png") => new File(["x"], name, { type });

beforeEach(() => {
  vi.clearAllMocks();
  actions.prepareMeasurementPhoto.mockResolvedValue({ canRemoveFiles: true });
  actions.addMeasurementPhoto.mockResolvedValue({ ok: true });
  actions.replaceMeasurementPhoto.mockResolvedValue({ ok: true });
  storage.upload.mockResolvedValue({ error: null });
  storage.remove.mockResolvedValue({ data: [], error: null });
});

describe("saveMeasurementPhoto", () => {
  it("checks first, then uploads a NEW file into the configuration's folder and records it", async () => {
    expect(await saveMeasurementPhoto(target, photo())).toBeNull();
    expect(actions.prepareMeasurementPhoto).toHaveBeenCalledWith(target.sledId, target.revisionId, target.settingId, false);
    expect(actions.prepareMeasurementPhoto).toHaveBeenCalledBefore(storage.upload);
    const [path, , options] = storage.upload.mock.calls[0];
    expect(path).toMatch(new RegExp(`^${target.sledId}/${target.revisionId}/[0-9a-f-]{36}\\.jpg$`));
    expect(options).toMatchObject({ upsert: false }); // never overwrites a file other configurations may share
    expect(actions.addMeasurementPhoto).toHaveBeenCalledWith(target.sledId, target.revisionId, target.settingId, path);
  });

  it("replaces with a new file, never the old one", async () => {
    expect(await saveMeasurementPhoto(target, photo(), { photoId: "p1", version: 3 })).toBeNull();
    expect(actions.prepareMeasurementPhoto).toHaveBeenCalledWith(target.sledId, target.revisionId, target.settingId, true);
    const [path] = storage.upload.mock.calls[0];
    expect(actions.replaceMeasurementPhoto).toHaveBeenCalledWith(target.sledId, target.revisionId, "p1", 3, path);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("uploads nothing when the check refuses (e.g. already 2 photos) or the file isn't an image", async () => {
    actions.prepareMeasurementPhoto.mockResolvedValueOnce({ error: "At most 2 photos per measurement.", canRemoveFiles: false });
    expect(await saveMeasurementPhoto(target, photo())).toBe("At most 2 photos per measurement.");
    expect(await saveMeasurementPhoto(target, photo("notes.txt", "text/plain"))).toBe("Choose an image file, such as a JPEG or PNG.");
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("retries a failed save once, then removes the file again (owners and editors)", async () => {
    actions.addMeasurementPhoto.mockResolvedValue({ error: "Something went wrong. Please try again." });
    expect(await saveMeasurementPhoto(target, photo())).toBe("Something went wrong. Please try again.");
    expect(actions.addMeasurementPhoto).toHaveBeenCalledTimes(2);
    expect(storage.remove).toHaveBeenCalledWith([storage.upload.mock.calls[0][0]]);
  });

  it("doesn't retry a final refusal; a mechanic's file is left for the cleanup", async () => {
    actions.prepareMeasurementPhoto.mockResolvedValue({ canRemoveFiles: false });
    actions.addMeasurementPhoto.mockResolvedValue({ error: "At most 2 photos per measurement." });
    expect(await saveMeasurementPhoto(target, photo())).toBe("At most 2 photos per measurement.");
    expect(actions.addMeasurementPhoto).toHaveBeenCalledTimes(1);
    expect(storage.remove).not.toHaveBeenCalled();
  });
});
