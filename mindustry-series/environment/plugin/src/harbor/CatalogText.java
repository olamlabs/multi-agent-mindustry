package harbor;

import mindustry.ctype.UnlockableContent;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.Properties;

final class CatalogText {
    private static final Properties descriptions = load();

    private static Properties load() {
        Properties result = new Properties();
        try (InputStream stream = CatalogText.class.getResourceAsStream("content-descriptions.properties")) {
            if (stream == null) throw new IOException("Missing bundled Mindustry content descriptions");
            result.load(new InputStreamReader(stream, StandardCharsets.UTF_8));
            return result;
        } catch (IOException error) {
            throw new ExceptionInInitializerError(error);
        }
    }

    static String description(UnlockableContent content) {
        return content.description != null ? content.description
            : descriptions.getProperty(content.getContentType() + "." + content.name + ".description");
    }
}
