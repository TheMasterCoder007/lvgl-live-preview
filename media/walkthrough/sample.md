## A minimal LVGL UI

Keep your UI code in your own init function, then let the preview call it from an
entry point wrapped in `#ifdef LVGL_LIVE_PREVIEW`:

```c
// your application's UI entry point
static void ui_init(void) {
    lv_obj_t *btn = lv_btn_create(lv_scr_act());
    lv_obj_center(btn);
}

#ifdef LVGL_LIVE_PREVIEW
// gives the live preview tool a way to initialize your UI
void lvgl_live_preview_init(void) {
    ui_init();
}
#endif
```

The `LVGL_LIVE_PREVIEW` macro is defined automatically during preview builds, so the
preview hook stays out of your firmware.

**Writing the glue in C++?** Run **LVGL: Open C++ Sample File** from the Command Palette
for a C++ entry point that drives a C LVGL UI. In C++, declare the entry point as
`extern "C" void lvgl_live_preview_init(void)` so its name isn't mangled.
