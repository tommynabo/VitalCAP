import { describe, expect, it, vi } from "vitest";
import { fetchBoundedDatasetItems } from "./provider-runs-runner";

describe("fetchBoundedDatasetItems", () => {
  it("paginates and respects the requested maximum", async () => {
    const getDatasetItems = vi.fn()
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, index) => ({ title: `A${index}` })))
      .mockResolvedValueOnce(Array.from({ length: 20 }, (_, index) => ({ title: `B${index}` })));
    const items = await fetchBoundedDatasetItems({ getDatasetItems }, "dataset-1", 120);
    expect(items).toHaveLength(120);
    expect(getDatasetItems).toHaveBeenNthCalledWith(1, "dataset-1", { offset: 0, limit: 100 });
    expect(getDatasetItems).toHaveBeenNthCalledWith(2, "dataset-1", { offset: 100, limit: 20 });
  });

  it("caps an oversized request at the safety limit", async () => {
    const getDatasetItems = vi.fn().mockResolvedValue([]);
    await fetchBoundedDatasetItems({ getDatasetItems }, "dataset-1", 5000);
    expect(getDatasetItems).toHaveBeenCalledWith("dataset-1", { offset: 0, limit: 100 });
  });
});
