import * as fs from 'fs';

/**
 * @class MainTemplate
 * @brief Class for generating the main.c file for the Emscripten build.
 */
export class MainTemplate {
	public static generateMainFile(outputPath: string): void {
		const mainCode = `
#include "lvgl.h"
#include <emscripten.h>
#include <SDL2/SDL.h>
#include <stdbool.h>
#include <stdio.h>

/* User function declaration - only visible when using LVGL Live Preview extension */
#ifdef LVGL_LIVE_PREVIEW
extern void lvgl_live_preview_init(void);
#endif

static SDL_Window *window = NULL;
static SDL_Renderer *renderer = NULL;
static SDL_Texture *texture = NULL;
static void *fb = NULL;

/* LVGL version detection - check for v9+ first, then fall back to v8 */
#if defined(LVGL_VERSION_MAJOR) && LVGL_VERSION_MAJOR >= 9
    #define LVGL_V9_OR_LATER 1
#elif defined(LV_VERSION_MAJOR) && LV_VERSION_MAJOR >= 9
    #define LVGL_V9_OR_LATER 1
#else
    #define LVGL_V9_OR_LATER 0
#endif

#if LVGL_V9_OR_LATER
static lv_display_t *disp = NULL;
#else
static lv_disp_drv_t disp_drv;
static lv_disp_draw_buf_t draw_buf;
static lv_disp_t *disp = NULL;
static lv_indev_drv_t indev_drv;
#endif

/* Get display dimensions from lv_conf.h */
#define DISP_HOR_RES MY_DISP_HOR_RES
#define DISP_VER_RES MY_DISP_VER_RES

/* Main loop function */
static void main_loop(void) {
    /* Handle SDL events */
    SDL_Event event;
    while (SDL_PollEvent(&event)) {
        if (event.type == SDL_QUIT) {
            emscripten_cancel_main_loop();
            return;
        }
    }

    /* Handle LVGL tasks */
#if LVGL_V9_OR_LATER
    lv_timer_handler();
#else
    lv_task_handler();
#endif
    lv_tick_inc(5);
}

/* Display flush callback */
#if LVGL_V9_OR_LATER
static void disp_flush(lv_display_t *disp_drv, const lv_area_t *area, uint8_t *px_map) {
    int32_t x, y;
    int32_t width = lv_area_get_width(area);
    int32_t height = lv_area_get_height(area);

    /* LVGL v9 provides color in native 32-bit format when LV_COLOR_DEPTH is 32 */
    uint32_t *src = (uint32_t *)px_map;

    /* Copy the rendered area to the frame buffer */
    for(y = 0; y < height; y++) {
        uint32_t *fb_ptr = (uint32_t *)fb + ((area->y1 + y) * DISP_HOR_RES + area->x1);

        for(x = 0; x < width; x++) {
            /* Direct copy - px_map is already in ARGB8888 format */
            *fb_ptr = *src;
            src++;
            fb_ptr++;
        }
    }

    /* Update SDL texture */
    SDL_UpdateTexture(texture, NULL, fb, DISP_HOR_RES * sizeof(uint32_t));
    SDL_RenderClear(renderer);
    SDL_RenderCopy(renderer, texture, NULL, NULL);
    SDL_RenderPresent(renderer);

    lv_display_flush_ready(disp_drv);
}
#else
static void disp_flush(lv_disp_drv_t *disp_drv, const lv_area_t *area, lv_color_t *color_p) {
    int32_t x, y;
    int32_t width = lv_area_get_width(area);
    int32_t height = lv_area_get_height(area);

    /* Copy the rendered area to the frame buffer */
    for(y = 0; y < height; y++) {
        uint32_t *fb_ptr = (uint32_t *)fb + ((area->y1 + y) * DISP_HOR_RES + area->x1);

        for(x = 0; x < width; x++) {
            /* LVGL v8: Convert lv_color_t to ARGB8888 */
#if LV_COLOR_DEPTH == 32
            *fb_ptr = color_p->full;
#elif LV_COLOR_DEPTH == 16
            uint8_t r = (color_p->ch.red * 255) / 31;
            uint8_t g = (color_p->ch.green * 255) / 63;
            uint8_t b = (color_p->ch.blue * 255) / 31;
            *fb_ptr = (0xFF << 24) | (r << 16) | (g << 8) | b;
#else
            /* Fallback for other color depths */
            lv_color32_t c32;
            c32.full = lv_color_to32(*color_p);
            *fb_ptr = c32.full;
#endif
            color_p++;
            fb_ptr++;
        }
    }

    /* Update SDL texture */
    SDL_UpdateTexture(texture, NULL, fb, DISP_HOR_RES * sizeof(uint32_t));
    SDL_RenderClear(renderer);
    SDL_RenderCopy(renderer, texture, NULL, NULL);
    SDL_RenderPresent(renderer);

    lv_disp_flush_ready(disp_drv);
}
#endif

/* Mouse/touch input callback */
#if LVGL_V9_OR_LATER
static void mouse_read(lv_indev_t *indev, lv_indev_data_t *data) {
#else
static void mouse_read(lv_indev_drv_t *indev_drv, lv_indev_data_t *data) {
    (void)indev_drv;
#endif
    int x, y;
    uint32_t buttons = SDL_GetMouseState(&x, &y);

    if (buttons & SDL_BUTTON_LMASK) {
        data->state = LV_INDEV_STATE_PRESSED;
    } else {
        data->state = LV_INDEV_STATE_RELEASED;
    }

    data->point.x = x;
    data->point.y = y;
}

int main(int argc, char *argv[]) {
    (void)argc;
    (void)argv;

    printf("Initializing LVGL Preview...\\n");

    /* Initialize SDL */
    if (SDL_Init(SDL_INIT_VIDEO) != 0) {
        printf("SDL_Init Error: %s\\n", SDL_GetError());
        return 1;
    }

    /* Create SDL window */
    window = SDL_CreateWindow("LVGL Preview",
                               SDL_WINDOWPOS_CENTERED,
                               SDL_WINDOWPOS_CENTERED,
                               DISP_HOR_RES, DISP_VER_RES,
                               SDL_WINDOW_SHOWN);
    if (!window) {
        printf("SDL_CreateWindow Error: %s\\n", SDL_GetError());
        SDL_Quit();
        return 1;
    }

    /* Create SDL renderer */
    renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED);
    if (!renderer) {
        printf("SDL_CreateRenderer Error: %s\\n", SDL_GetError());
        SDL_DestroyWindow(window);
        SDL_Quit();
        return 1;
    }

    /* Create SDL texture for frame buffer */
    texture = SDL_CreateTexture(renderer,
                                SDL_PIXELFORMAT_ARGB8888,
                                SDL_TEXTUREACCESS_STATIC,
                                DISP_HOR_RES, DISP_VER_RES);
    if (!texture) {
        printf("SDL_CreateTexture Error: %s\\n", SDL_GetError());
        SDL_DestroyRenderer(renderer);
        SDL_DestroyWindow(window);
        SDL_Quit();
        return 1;
    }

    /* Allocate frame buffer */
    fb = malloc(DISP_HOR_RES * DISP_VER_RES * sizeof(uint32_t));
    if (!fb) {
        printf("Failed to allocate frame buffer\\n");
        SDL_DestroyTexture(texture);
        SDL_DestroyRenderer(renderer);
        SDL_DestroyWindow(window);
        SDL_Quit();
        return 1;
    }
    memset(fb, 0, DISP_HOR_RES * DISP_VER_RES * sizeof(uint32_t));

    printf("SDL initialized successfully\\n");

    /* Initialize LVGL */
    lv_init();
    printf("LVGL initialized\\n");

    /* Allocate draw buffers */
    size_t buf_size = DISP_HOR_RES * 10 * sizeof(lv_color_t);
    void *buf1 = malloc(buf_size);
    void *buf2 = malloc(buf_size);

    if (!buf1 || !buf2) {
        printf("Failed to allocate draw buffers\\n");
        return 1;
    }

#if LVGL_V9_OR_LATER
    /* LVGL 9.x display initialization */
    disp = lv_display_create(DISP_HOR_RES, DISP_VER_RES);
    lv_display_set_flush_cb(disp, disp_flush);
    lv_display_set_buffers(disp, buf1, buf2, buf_size, LV_DISPLAY_RENDER_MODE_PARTIAL);

    printf("Display created (LVGL 9.x)\\n");

    /* Create input device - LVGL 9.x */
    lv_indev_t *mouse_indev = lv_indev_create();
    lv_indev_set_type(mouse_indev, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(mouse_indev, mouse_read);
#else
    /* LVGL 8.x display initialization */
    lv_disp_draw_buf_init(&draw_buf, buf1, buf2, DISP_HOR_RES * 10);

    lv_disp_drv_init(&disp_drv);
    disp_drv.hor_res = DISP_HOR_RES;
    disp_drv.ver_res = DISP_VER_RES;
    disp_drv.flush_cb = disp_flush;
    disp_drv.draw_buf = &draw_buf;
    disp = lv_disp_drv_register(&disp_drv);

    printf("Display created (LVGL 8.x)\\n");

    /* Create input device - LVGL 8.x */
    lv_indev_drv_init(&indev_drv);
    indev_drv.type = LV_INDEV_TYPE_POINTER;
    indev_drv.read_cb = mouse_read;
    lv_indev_drv_register(&indev_drv);
#endif

    printf("Input device created\\n");

    /* Call user initialization */
#ifdef LVGL_LIVE_PREVIEW
    printf("Calling user init...\\n");
    lvgl_live_preview_init();
    printf("User init complete\\n");
#endif

    /* Start main loop */
    emscripten_set_main_loop(main_loop, 0, 1);

    return 0;
}
`;

		fs.writeFileSync(outputPath, mainCode);
	}
}
