import * as fs from 'fs';

/**
 * @class MainTemplate
 * @brief Class for generating the main.c file for the Emscripten build.
 *
 * @description
 * Generates a main.c file with dual implementations for LVGL v8 and v9.
 * The version detection happens at compile-time using preprocessor macros.
 */
export class MainTemplate {
	public static generateMainFile(outputPath: string): void {
		const mainCode = `/**
 * @file main.c
 * @brief Main entry point for LVGL Live Preview with Emscripten
 *
 * This file provides dual implementations for LVGL v8 and v9:
 * - LVGL v9: Uses built-in SDL driver (lv_sdl_window_create API)
 * - LVGL v8: Uses lv_drivers SDL driver (sdl_init/sdl_display_flush API)
 */

#include "lvgl.h"
#include <emscripten.h>
#include <SDL2/SDL.h>
#include <stdbool.h>
#include <stdio.h>

/* User function declaration - only visible when using LVGL Live Preview extension */
#ifdef LVGL_LIVE_PREVIEW
extern void lvgl_live_preview_init(void);
#endif

/* LVGL version detection - check for v9+ first, then fall back to v8 */
#if defined(LVGL_VERSION_MAJOR) && LVGL_VERSION_MAJOR >= 9
    #define LVGL_V9_OR_LATER 1
#elif defined(LV_VERSION_MAJOR) && LV_VERSION_MAJOR >= 9
    #define LVGL_V9_OR_LATER 1
#else
    #define LVGL_V9_OR_LATER 0
#endif

/* Get display dimensions from lv_conf.h */
#if LVGL_V9_OR_LATER
    #define DISP_HOR_RES SDL_HOR_RES
    #define DISP_VER_RES SDL_VER_RES
#else
    #define DISP_HOR_RES MY_DISP_HOR_RES
    #define DISP_VER_RES MY_DISP_VER_RES
#endif

/*====================
 * LVGL V9 IMPLEMENTATION
 * Uses built-in SDL driver
 *====================*/
#if LVGL_V9_OR_LATER

#include "drivers/sdl/lv_sdl_window.h"
#include "drivers/sdl/lv_sdl_mouse.h"
#include "drivers/sdl/lv_sdl_mousewheel.h"
#include "drivers/sdl/lv_sdl_keyboard.h"

static lv_display_t *disp = NULL;

/**
 * @brief Main loop function for LVGL v9
 *
 * Handles LVGL timer tasks and adds a small delay to prevent
 * excessive CPU usage. Called by Emscripten main loop.
 */
static void main_loop(void) {
    lv_timer_handler();
    SDL_Delay(5);
}

int main(int argc, char *argv[]) {
    (void)argc;
    (void)argv;

    printf("Initializing LVGL Preview (v9+)...\\n");

    /* Initialize LVGL */
    lv_init();
    printf("LVGL initialized\\n");

    /* Create SDL window and display */
    disp = lv_sdl_window_create(DISP_HOR_RES, DISP_VER_RES);
    if (!disp) {
        printf("Failed to create SDL window\\n");
        return 1;
    }
    printf("SDL window created (LVGL v9+ built-in driver)\\n");

    /* Create input devices */
    lv_indev_t *mouse = lv_sdl_mouse_create();
    if (mouse) {
        printf("Mouse input device created\\n");
    }

    lv_sdl_mousewheel_create();
    printf("Mouse wheel input device created\\n");

    lv_sdl_keyboard_create();
    printf("Keyboard input device created\\n");

    /* Call user initialization */
#ifdef LVGL_LIVE_PREVIEW
    printf("Calling user init...\\n");
    lvgl_live_preview_init();
    printf("User init complete\\n");
#endif

    /* Start Emscripten main loop */
    printf("Starting main loop...\\n");
    emscripten_set_main_loop(main_loop, 0, 1);

    return 0;
}

/*====================
 * LVGL V8 IMPLEMENTATION
 * Uses lv_drivers SDL driver
 *====================*/
#else

#include "sdl/sdl_common.h"
#include "sdl/sdl_common_internal.h"

static lv_disp_t *disp = NULL;

/**
 * @brief Custom tick implementation for LVGL v8
 *
 * Provides system tick in milliseconds using SDL's timer.
 * Called by LVGL when LV_TICK_CUSTOM = 1.
 *
 * @return Current time in milliseconds since SDL initialization.
 */
uint32_t lv_tick_get(void) {
    return SDL_GetTicks();
}

/**
 * @brief Get elapsed time since a previous timestamp
 *
 * Calculates the time difference between current time and a previous timestamp,
 * handling potential 32-bit wraparound correctly.
 *
 * @param prev_tick Previous timestamp from lv_tick_get()
 * @return Elapsed milliseconds since prev_tick
 */
uint32_t lv_tick_elaps(uint32_t prev_tick) {
    uint32_t act_time = SDL_GetTicks();

    /* Handle 32-bit wraparound */
    if(act_time >= prev_tick) {
        return act_time - prev_tick;
    } else {
        return UINT32_MAX - prev_tick + act_time + 1;
    }
}

/**
 * @brief Main loop function for LVGL v8
 *
 * Handles LVGL task processing, polls SDL events manually for Emscripten compatibility,
 * and adds a small delay to prevent excessive CPU usage. Called by Emscripten main loop.
 */
static void main_loop(void) {
    /* Poll SDL events manually for Emscripten compatibility */
    SDL_Event event;
    while(SDL_PollEvent(&event)) {
        mouse_handler(&event);
        mousewheel_handler(&event);
        keyboard_handler(&event);
    }

    lv_task_handler();
    SDL_Delay(5);
}

int main(int argc, char *argv[]) {
    (void)argc;
    (void)argv;

    printf("Initializing LVGL Preview (v8)...\\n");

    /* Initialize LVGL */
    lv_init();
    printf("LVGL initialized\\n");

    /* Initialize SDL driver from lv_drivers */
    sdl_init();
    printf("SDL initialized (lv_drivers)\\n");

    /* Setup display driver */
    static lv_disp_draw_buf_t draw_buf;
    static lv_color_t buf1[DISP_HOR_RES * 10];
    static lv_color_t buf2[DISP_HOR_RES * 10];
    lv_disp_draw_buf_init(&draw_buf, buf1, buf2, DISP_HOR_RES * 10);

    static lv_disp_drv_t disp_drv;
    lv_disp_drv_init(&disp_drv);
    disp_drv.draw_buf = &draw_buf;
    disp_drv.flush_cb = sdl_display_flush;
    disp_drv.hor_res = DISP_HOR_RES;
    disp_drv.ver_res = DISP_VER_RES;
    disp = lv_disp_drv_register(&disp_drv);

    printf("Display driver registered\\n");

    /* Setup mouse input device */
    static lv_indev_drv_t indev_drv_mouse;
    lv_indev_drv_init(&indev_drv_mouse);
    indev_drv_mouse.type = LV_INDEV_TYPE_POINTER;
    indev_drv_mouse.read_cb = sdl_mouse_read;
    lv_indev_drv_register(&indev_drv_mouse);

    printf("Mouse input device registered\\n");

    /* Setup mouse wheel input device */
    static lv_indev_drv_t indev_drv_mousewheel;
    lv_indev_drv_init(&indev_drv_mousewheel);
    indev_drv_mousewheel.type = LV_INDEV_TYPE_ENCODER;
    indev_drv_mousewheel.read_cb = sdl_mousewheel_read;
    lv_indev_drv_register(&indev_drv_mousewheel);

    printf("Mouse wheel input device registered\\n");

    /* Setup keyboard input device */
    static lv_indev_drv_t indev_drv_keyboard;
    lv_indev_drv_init(&indev_drv_keyboard);
    indev_drv_keyboard.type = LV_INDEV_TYPE_KEYPAD;
    indev_drv_keyboard.read_cb = sdl_keyboard_read;
    lv_indev_drv_register(&indev_drv_keyboard);

    printf("Keyboard input device registered\\n");

    /* Call user initialization */
#ifdef LVGL_LIVE_PREVIEW
    printf("Calling user init...\\n");
    lvgl_live_preview_init();
    printf("User init complete\\n");
#endif

    /* Start Emscripten main loop */
    printf("Starting main loop...\\n");
    emscripten_set_main_loop(main_loop, 0, 1);

    return 0;
}

#endif /* LVGL_V9_OR_LATER */
`;

		fs.writeFileSync(outputPath, mainCode);
	}
}
