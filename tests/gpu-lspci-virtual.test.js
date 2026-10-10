import { describe, expect, it } from "vitest";
import { isNonComputeDisplay, parseLspciLine, parseLspciLines } from "../packages/gpu/src/detect.js";

describe("lspci fallback — virtual and BMC display adapters", () => {
    it("drops QEMU std-vga in both -mm and -nn output", () => {
        const mm = '00:02.0 "VGA compatible controller" "Vendor 1234" "Device 1111" -r02 -p00 "Red Hat, Inc." "Device 1100"';
        const nn = "00:02.0 VGA compatible controller [0300]: Device [1234:1111] (rev 02)";
        expect(isNonComputeDisplay(mm)).toBe(true);
        expect(isNonComputeDisplay(nn)).toBe(true);
        expect(parseLspciLines([mm])).toEqual([]);
        expect(parseLspciLines([nn])).toEqual([]);
    });

    it("drops ASPEED BMC, Cirrus, VMware and virtio adapters", () => {
        for (const line of [
            "03:00.0 VGA compatible controller [0300]: ASPEED Technology, Inc. ASPEED Graphics Family [1a03:2000] (rev 41)",
            "00:02.0 VGA compatible controller [0300]: Cirrus Logic GD 5446 [1013:00b8]",
            '00:0f.0 "VGA compatible controller" "VMware" "SVGA II Adapter"',
            "00:01.0 VGA compatible controller [0300]: Red Hat, Inc. Virtio 1.0 GPU [1af4:1050] (rev 01)",
        ]) {
            expect(isNonComputeDisplay(line)).toBe(true);
        }
    });

    it("keeps a real NVIDIA card next to a BMC framebuffer", () => {
        const gpus = parseLspciLines([
            "03:00.0 VGA compatible controller [0300]: ASPEED Technology, Inc. ASPEED Graphics Family [1a03:2000] (rev 41)",
            "41:00.0 3D controller [0302]: NVIDIA Corporation AD102 [GeForce RTX 4090] [10de:2684] (rev a1)",
        ]);
        expect(gpus).toHaveLength(1);
        expect(gpus[0].vendor).toBe("nvidia");
        expect(gpus[0].index).toBe(0);
    });

    it("builds the -mm model from vendor + device, not the class name", () => {
        const g = parseLspciLine('01:00.0 "VGA compatible controller" "NVIDIA Corporation" "AD102 [GeForce RTX 4090]" -ra1', 0);
        expect(g.model).toBe("NVIDIA Corporation AD102 [GeForce RTX 4090]");
        expect(g.vendor).toBe("nvidia");
    });
});
