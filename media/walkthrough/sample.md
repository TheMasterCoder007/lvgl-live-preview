## A minimal LVGL UI

Every previewed file must define an entry point wrapped in `#ifdef LVGL_LIVE_PREVIEW`:

```c
#ifdef LVGL_LIVE_PREVIEW
void lvgl_live_preview_init(void) {
    lv_obj_t *btn = lv_btn_create(lv_scr_act());
    lv_obj_center(btn);
}
#endif
```

The `LVGL_LIVE_PREVIEW` macro is defined automatically during preview builds, so this
code stays out of your firmware.
