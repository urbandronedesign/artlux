// NVAPI scanout warp + intensity shim. Exposes a tiny C ABI the Rust addon calls. The real branch
// (NVWARP_HAVE_NVAPI) uses NVIDIA's NVAPI per the documented Warp & Blend interface (cf.
// errollw/Warp-and-Blend-Quadros): Initialize -> EnumPhysicalGPUs -> GetConnectedDisplayIds ->
// GetScanoutConfigurationEx (desktop rect) -> SetScanoutWarping (XYUVRQ mesh) / SetScanoutIntensity
// (RGB blend texture). The stub branch reports "unavailable" so the addon builds + loads on any host.
//
// NOTE: the real branch compiles only with the NVAPI SDK present (NVAPI_SDK_DIR) and is validated on a
// Quadro/RTX-pro GPU; struct field spellings (NvSBox, NV_SCANOUT_INFORMATION) follow the SDK headers.

#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <cstdio>

#ifdef NVWARP_HAVE_NVAPI
#include "nvapi.h"
#endif

extern "C" {

// Initialize NVAPI; returns 1 when present + initialized (a warp-capable pro GPU), else 0.
int nvw_init() {
#ifdef NVWARP_HAVE_NVAPI
    return NvAPI_Initialize() == NVAPI_OK ? 1 : 0;
#else
    return 0;
#endif
}

void nvw_unload() {
#ifdef NVWARP_HAVE_NVAPI
    NvAPI_Unload();
#endif
}

// Enumerate connected displays across all GPUs. Fills ids[i] (NVAPI displayId) and rects[i*4..] with
// the scanout source-desktop rect (x,y,w,h, in the virtual desktop) so the host can map NVAPI displays
// to Electron displays by bounds. Returns the count written (<= max).
int nvw_list_displays(uint32_t* ids, int32_t* rects, int max) {
#ifdef NVWARP_HAVE_NVAPI
    NvPhysicalGpuHandle gpus[NVAPI_MAX_PHYSICAL_GPUS];
    NvU32 gpuCount = 0;
    if (NvAPI_EnumPhysicalGPUs(gpus, &gpuCount) != NVAPI_OK) return 0;
    int out = 0;
    for (NvU32 g = 0; g < gpuCount && out < max; g++) {
        NvU32 dispCount = 0;
        if (NvAPI_GPU_GetConnectedDisplayIds(gpus[g], NULL, &dispCount, 0) != NVAPI_OK || dispCount == 0) continue;
        NV_GPU_DISPLAYIDS* disp = (NV_GPU_DISPLAYIDS*)calloc(dispCount, sizeof(NV_GPU_DISPLAYIDS));
        if (!disp) continue;
        disp[0].version = NV_GPU_DISPLAYIDS_VER;
        if (NvAPI_GPU_GetConnectedDisplayIds(gpus[g], disp, &dispCount, 0) == NVAPI_OK) {
            for (NvU32 d = 0; d < dispCount && out < max; d++) {
                NV_SCANOUT_INFORMATION si;
                memset(&si, 0, sizeof(si));
                si.version = NV_SCANOUT_INFORMATION_VER;
                if (NvAPI_GPU_GetScanoutConfigurationEx(disp[d].displayId, &si) == NVAPI_OK) {
                    ids[out] = disp[d].displayId;
                    rects[out * 4 + 0] = si.sourceDesktopRect.sX;
                    rects[out * 4 + 1] = si.sourceDesktopRect.sY;
                    rects[out * 4 + 2] = (int32_t)si.sourceDesktopRect.sWidth;
                    rects[out * 4 + 3] = (int32_t)si.sourceDesktopRect.sHeight;
                    out++;
                }
            }
        }
        free(disp);
    }
    return out;
#else
    (void)ids; (void)rects; (void)max;
    return 0;
#endif
}

// Push a warp mesh to a display. verts = numVerts * 6 floats (X,Y screen + U,V texcoord + R,Q
// perspective), as a triangle LIST (every 3 verts = 1 triangle — same decomposition the GLSL path
// uses, so hardware and GLSL agree). (sl,st,sw,sh) = the source desktop rect the UVs index into.
int nvw_set_warping(uint32_t displayId, const float* verts, int numVerts, int sl, int st, int sw, int sh) {
#ifdef NVWARP_HAVE_NVAPI
    NvSBox rect;
    memset(&rect, 0, sizeof(rect));
    rect.sX = sl; rect.sY = st; rect.sWidth = sw; rect.sHeight = sh;
    NV_SCANOUT_WARPING_DATA data;
    memset(&data, 0, sizeof(data));
    data.version = NV_SCANOUT_WARPING_VER;
    data.numVertices = numVerts;
    data.vertexFormat = NV_GPU_WARPING_VERTICE_FORMAT_TRIANGLES_XYUVRQ;
    data.textureRect = &rect;
    data.vertices = (float*)verts;
    int maxNumVertices = 0;
    int sticky = 0;
    NvAPI_Status st_ = NvAPI_GPU_SetScanoutWarping(displayId, &data, &maxNumVertices, &sticky);
    // maxNumVertices is the driver's cap, and it used to be read into this local and thrown away.
    // We send a dense triangle LIST (24x24 grid = 3456 vertices) where the public reference sends a
    // 4-vertex TRIANGLESTRIP, so exceeding the cap is a real possibility — and its symptom is the
    // worst kind: the call fails, the output renders unwarped, and nothing anywhere says why. Say why.
    if (st_ != NVAPI_OK) {
        fprintf(stderr, "[nvwarp] SetScanoutWarping failed on display 0x%08X: status=%d, sent %d verts, driver max=%d\n",
                displayId, (int)st_, numVerts, maxNumVertices);
    }
    return st_ == NVAPI_OK ? 1 : 0;
#else
    (void)displayId; (void)verts; (void)numVerts; (void)sl; (void)st; (void)sw; (void)sh;
    return 0;
#endif
}

// Push an intensity/blend map (w*h*3 floats, 0..1 RGB) to a display — edge blend + brightness/colour.
int nvw_set_intensity(uint32_t displayId, int w, int h, const float* rgb) {
#ifdef NVWARP_HAVE_NVAPI
    NV_SCANOUT_INTENSITY_DATA data;
    memset(&data, 0, sizeof(data));
    data.version = NV_SCANOUT_INTENSITY_DATA_VER;
    data.width = w;
    data.height = h;
    data.blendingTexture = (float*)rgb;
    data.offsetTexture = NULL;
    data.offsetTexChannels = 1;
    int sticky = 0;
    return NvAPI_GPU_SetScanoutIntensity(displayId, &data, &sticky) == NVAPI_OK ? 1 : 0;
#else
    (void)displayId; (void)w; (void)h; (void)rgb;
    return 0;
#endif
}

// Remove warp + intensity from a display (numVertices=0 clears the warp; null texture clears blend).
int nvw_clear(uint32_t displayId) {
#ifdef NVWARP_HAVE_NVAPI
    int sticky = 0;
    NV_SCANOUT_WARPING_DATA w;
    memset(&w, 0, sizeof(w));
    w.version = NV_SCANOUT_WARPING_VER;
    w.numVertices = 0;
    int maxNumVertices = 0;
    NvAPI_GPU_SetScanoutWarping(displayId, &w, &maxNumVertices, &sticky);
    NV_SCANOUT_INTENSITY_DATA i;
    memset(&i, 0, sizeof(i));
    i.version = NV_SCANOUT_INTENSITY_DATA_VER;
    i.width = 0; i.height = 0; i.blendingTexture = NULL;
    NvAPI_GPU_SetScanoutIntensity(displayId, &i, &sticky);
    return 1;
#else
    (void)displayId;
    return 0;
#endif
}

} // extern "C"
