# capture_scenes.gd — render each scene once and save a PNG (used by godot-remote.sh render).
# Run: godot --rendering-driver opengl3 --path godot-project -s res://.jv_tools/capture_scenes.gd ++ <out_dir> [res://scenes/a.tscn ...]
# No scenes given -> every res://scenes/*.tscn. Exit code = number of scenes that failed.
extends SceneTree

const SETTLE_FRAMES := 30

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	var args := OS.get_cmdline_user_args()
	if args.is_empty():
		push_error("usage: ++ <out_dir> [scene ...]")
		quit(2)
		return
	var out_dir: String = args[0]
	var scenes: Array = args.slice(1)
	if scenes.is_empty():
		for dir_path in ["res://scenes", "res://tests/render"]:
			var d := DirAccess.open(dir_path)
			if d:
				for f in d.get_files():
					if f.ends_with(".tscn"):
						scenes.append(dir_path + "/" + f)
	scenes.sort()
	if scenes.is_empty():
		printerr("FAIL no scenes to render: add .tscn files under res://scenes or res://tests/render (a preview scene for art-only changes)")
		var nf := FileAccess.open(out_dir.path_join("scenes.txt"), FileAccess.WRITE)
		if nf:
			nf.store_string("FAIL no scenes found under res://scenes or res://tests/render\n")
		quit(1)
		return
	var failed := 0
	var lines: PackedStringArray = []
	for path in scenes:
		var packed := load(path) as PackedScene
		if packed == null:
			printerr("FAIL load ", path)
			lines.append("FAIL %s load" % path)
			failed += 1
			continue
		var node := packed.instantiate()
		root.add_child(node)
		for i in SETTLE_FRAMES:
			await process_frame
		await RenderingServer.frame_post_draw
		var img := root.get_viewport().get_texture().get_image()
		var png: String = out_dir.path_join(path.get_file().get_basename() + ".png")
		if img == null or img.is_empty() or img.save_png(png) != OK:
			printerr("FAIL capture ", path)
			lines.append("FAIL %s capture" % path)
			failed += 1
		else:
			print("OK ", path, " -> ", png)
			lines.append("OK %s %s" % [path, png.get_file()])
		node.queue_free()
		await process_frame
	var f := FileAccess.open(out_dir.path_join("scenes.txt"), FileAccess.WRITE)
	if f:
		f.store_string("\n".join(lines) + "\n")
	quit(failed)
