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

/* User function declaration */
extern void lvgl_live_preview_init(void);

static SDL_Window *window = NULL;
static SDL_Renderer *renderer = NULL;
static SDL_Texture *texture = NULL;
static lv_display_t *disp = NULL;
static void *fb = NULL;

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
    lv_timer_handler();
    lv_tick_inc(5);
}

/* Display flush callback */
static void disp_flush(lv_display_t *disp_drv, const lv_area_t *area, uint8_t *px_map) {
    int32_t x, y;
    int32_t width = lv_area_get_width(area);
    int32_t height = lv_area_get_height(area);

    /* LVGL v9 provides color in native 32-bit format when LV_COLOR_DEPTH is 32 */
    uint32_t *color_p = (uint32_t *)px_map;

    /* Copy the rendered area to the frame buffer */
    for(y = 0; y < height; y++) {
        uint32_t *fb_ptr = (uint32_t *)fb + ((area->y1 + y) * DISP_HOR_RES + area->x1);

        for(x = 0; x < width; x++) {
            /* Direct copy - px_map is already in ARGB8888 format */
            *fb_ptr = *color_p;

            color_p++;
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

/* Mouse/touch input callback */
static void mouse_read(lv_indev_t *indev, lv_indev_data_t *data) {
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

    /* Create display */
    disp = lv_display_create(DISP_HOR_RES, DISP_VER_RES);
    lv_display_set_flush_cb(disp, disp_flush);

    /* Allocate draw buffers */
    size_t buf_size = DISP_HOR_RES * 10 * sizeof(lv_color_t);
    void *buf1 = malloc(buf_size);
    void *buf2 = malloc(buf_size);

    if (!buf1 || !buf2) {
        printf("Failed to allocate draw buffers\\n");
        return 1;
    }

    lv_display_set_buffers(disp, buf1, buf2, buf_size, LV_DISPLAY_RENDER_MODE_PARTIAL);

    printf("Display created\\n");

    /* Create input device */
    lv_indev_t *mouse_indev = lv_indev_create();
    lv_indev_set_type(mouse_indev, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(mouse_indev, mouse_read);

    printf("Input device created\\n");

    /* Call user initialization */
    printf("Calling user init...\\n");
    lvgl_live_preview_init();
    printf("User init complete\\n");

    /* Start main loop */
    emscripten_set_main_loop(main_loop, 0, 1);

    return 0;
}
`;

		fs.writeFileSync(outputPath, mainCode);
	}
}
