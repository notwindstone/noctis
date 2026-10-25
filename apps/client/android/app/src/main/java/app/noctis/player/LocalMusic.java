package app.noctis.player;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.util.Size;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

/**
 * Music on the device, two ways:
 *
 * - the whole device, from Android's own index of audio files (MediaStore), with the
 *   "Music and audio" permission (storage on Android 12 and older);
 * - folders the user picked (Storage Access Framework), for music the index misses
 *   (.nomedia folders, unindexed locations): a recursive walk with tags from
 *   MediaMetadataRetriever. These need no permission beyond the persisted grant.
 *
 * Both report `key`, "<volume>:<path>", so a file found both ways is listed once.
 */
final class LocalMusic {

    interface Progress {
        void onProgress(int count);
    }

    private static final int ARTWORK_SIZE = 300;

    private LocalMusic() {}

    /** Every audio file under `tree`, with its tags. */
    static JSArray scan(Context context, Uri tree, Progress progress) {
        JSArray files = new JSArray();
        String root = DocumentsContract.getTreeDocumentId(tree);
        walk(context, tree, root, "", files, progress);
        return files;
    }

    private static void walk(Context context, Uri tree, String documentId, String path, JSArray files, Progress progress) {
        ContentResolver resolver = context.getContentResolver();
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, documentId);
        String[] columns = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        };
        try (Cursor cursor = resolver.query(children, columns, null, null, null)) {
            if (cursor == null) return;
            while (cursor.moveToNext()) {
                String id = cursor.getString(0);
                String name = cursor.getString(1);
                String mime = cursor.getString(2);
                if (name == null || name.startsWith(".")) continue;
                String childPath = path.isEmpty() ? name : path + "/" + name;
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    walk(context, tree, id, childPath, files, progress);
                } else if (mime != null && mime.startsWith("audio/")) {
                    Uri uri = DocumentsContract.buildDocumentUriUsingTree(tree, id);
                    JSObject file = new JSObject();
                    file.put("uri", uri.toString());
                    file.put("path", childPath);
                    // External storage document ids are "<volume>:<path>", like MediaStore keys below.
                    file.put("key", id.toLowerCase(java.util.Locale.ROOT));
                    file.put("mimeType", mime);
                    file.put("size", cursor.getLong(3));
                    file.put("modified", cursor.getLong(4));
                    readTags(context, uri, file);
                    files.put(file);
                    if (files.length() % 25 == 0) progress.onProgress(files.length());
                }
            }
        } catch (Exception ignored) {
            // An unreadable folder is skipped, not fatal.
        }
    }

    private static void readTags(Context context, Uri uri, JSObject file) {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(context, uri);
            put(file, "title", retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE));
            put(file, "artist", retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST));
            put(file, "album", retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM));
            put(file, "albumArtist", retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST));
            put(file, "genre", retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_GENRE));
            putNumber(file, "track", retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CD_TRACK_NUMBER));
            putNumber(file, "disc", retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DISC_NUMBER));
            putNumber(file, "year", retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_YEAR));
            putNumber(file, "durationMs", retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION));
            putNumber(file, "bitrate", retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE));
            file.put("hasArtwork", retriever.getEmbeddedPicture() != null);
        } catch (Exception ignored) {
            // Untagged or unreadable: the file name stands in for the title.
        } finally {
            try {
                retriever.release();
            } catch (Exception ignored) {
                // nothing to release
            }
        }
    }

    /** Every song in Android's media index (music only: no ringtones or notifications). */
    static JSArray scanMediaStore(Context context, Progress progress) {
        JSArray files = new JSArray();
        boolean modern = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
        boolean rich = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R;
        Uri collection = modern ? MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL) : MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        java.util.List<String> columns = new java.util.ArrayList<>(java.util.Arrays.asList(
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.DISPLAY_NAME,
            MediaStore.Audio.Media.TITLE,
            MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.ALBUM,
            MediaStore.Audio.Media.TRACK,
            MediaStore.Audio.Media.YEAR,
            MediaStore.Audio.Media.DURATION,
            MediaStore.Audio.Media.MIME_TYPE,
            MediaStore.Audio.Media.SIZE,
            MediaStore.Audio.Media.DATE_MODIFIED
        ));
        if (modern) {
            columns.add(MediaStore.Audio.Media.RELATIVE_PATH);
            columns.add(MediaStore.Audio.Media.VOLUME_NAME);
        } else {
            columns.add(MediaStore.Audio.Media.DATA);
        }
        if (rich) {
            columns.add(MediaStore.Audio.Media.ALBUM_ARTIST);
            columns.add(MediaStore.Audio.Media.GENRE);
            columns.add(MediaStore.Audio.Media.BITRATE);
        }
        String selection = MediaStore.Audio.Media.IS_MUSIC + " != 0";
        try (Cursor cursor = context.getContentResolver().query(collection, columns.toArray(new String[0]), selection, null, null)) {
            if (cursor == null) return files;
            while (cursor.moveToNext()) {
                long id = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Audio.Media._ID));
                String name = string(cursor, MediaStore.Audio.Media.DISPLAY_NAME);
                String volume;
                String path;
                if (modern) {
                    String relative = string(cursor, MediaStore.Audio.Media.RELATIVE_PATH);
                    path = (relative == null ? "" : relative) + (name == null ? "" : name);
                    String rawVolume = string(cursor, MediaStore.Audio.Media.VOLUME_NAME);
                    volume = rawVolume == null || MediaStore.VOLUME_EXTERNAL_PRIMARY.equals(rawVolume) ? "primary" : rawVolume;
                } else {
                    String data = string(cursor, MediaStore.Audio.Media.DATA);
                    path = data == null ? (name == null ? "" : name) : data.replaceFirst("^/storage/emulated/\\d+/", "").replaceFirst("^/sdcard/", "");
                    volume = "primary";
                }
                Uri uri = ContentUris.withAppendedId(collection, id);
                JSObject file = new JSObject();
                file.put("uri", uri.toString());
                file.put("path", path);
                file.put("key", (volume + ":" + path).toLowerCase(java.util.Locale.ROOT));
                file.put("mimeType", string(cursor, MediaStore.Audio.Media.MIME_TYPE));
                file.put("size", cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE)));
                file.put("modified", cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_MODIFIED)) * 1000);
                put(file, "title", string(cursor, MediaStore.Audio.Media.TITLE));
                String artist = string(cursor, MediaStore.Audio.Media.ARTIST);
                if (artist != null && !"<unknown>".equals(artist)) put(file, "artist", artist);
                put(file, "album", string(cursor, MediaStore.Audio.Media.ALBUM));
                // TRACK is disc * 1000 + track.
                int track = cursor.getInt(cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.TRACK));
                if (track % 1000 > 0) file.put("track", track % 1000);
                if (track >= 1000) file.put("disc", track / 1000);
                int year = cursor.getInt(cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.YEAR));
                if (year > 0) file.put("year", year);
                long duration = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION));
                if (duration > 0) file.put("durationMs", duration);
                if (rich) {
                    put(file, "albumArtist", string(cursor, MediaStore.Audio.Media.ALBUM_ARTIST));
                    put(file, "genre", string(cursor, MediaStore.Audio.Media.GENRE));
                    long bitrate = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.BITRATE));
                    if (bitrate > 0) file.put("bitrate", bitrate);
                }
                // Unknown without opening the file; the app tries one per album.
                file.put("hasArtwork", true);
                files.put(file);
                if (files.length() % 100 == 0) progress.onProgress(files.length());
            }
        }
        return files;
    }

    private static String string(Cursor cursor, String column) {
        int index = cursor.getColumnIndex(column);
        return index < 0 || cursor.isNull(index) ? null : cursor.getString(index);
    }

    /** Embedded artwork, downscaled to at most ARTWORK_SIZE px, as a data: URL; or null. */
    static String artwork(Context context, Uri uri) {
        // Android 10+: the system's thumbnail (cached, and it finds artwork MediaStore knows about).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && "media".equals(uri.getAuthority())) {
            try {
                android.graphics.Bitmap thumbnail = context.getContentResolver().loadThumbnail(uri, new Size(ARTWORK_SIZE, ARTWORK_SIZE), null);
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                thumbnail.compress(android.graphics.Bitmap.CompressFormat.JPEG, 85, out);
                return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
            } catch (Exception ignored) {
                // No thumbnail: try the embedded picture.
            }
        }
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(context, uri);
            byte[] picture = retriever.getEmbeddedPicture();
            if (picture == null) return null;
            // Downscaled: the app keeps one per album, and embedded art can be megabytes.
            android.graphics.Bitmap bitmap = android.graphics.BitmapFactory.decodeByteArray(picture, 0, picture.length);
            if (bitmap == null) return null;
            float scale = Math.min(1f, (float) ARTWORK_SIZE / Math.max(bitmap.getWidth(), bitmap.getHeight()));
            android.graphics.Bitmap scaled = android.graphics.Bitmap.createScaledBitmap(
                bitmap, Math.max(1, Math.round(bitmap.getWidth() * scale)), Math.max(1, Math.round(bitmap.getHeight() * scale)), true);
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            scaled.compress(android.graphics.Bitmap.CompressFormat.JPEG, 85, out);
            return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        } finally {
            try {
                retriever.release();
            } catch (Exception ignored) {
                // nothing to release
            }
        }
    }

    private static void put(JSObject object, String key, String value) {
        if (value != null && !value.trim().isEmpty()) object.put(key, value.trim());
    }

    /** Tags like "3/12" (track 3 of 12) or "2021-05-01": the leading number. */
    private static void putNumber(JSObject object, String key, String value) {
        if (value == null) return;
        java.util.regex.Matcher match = java.util.regex.Pattern.compile("^\\s*(\\d+)").matcher(value);
        if (match.find()) {
            try {
                object.put(key, Long.parseLong(match.group(1)));
            } catch (NumberFormatException ignored) {
                // not a number after all
            }
        }
    }
}
