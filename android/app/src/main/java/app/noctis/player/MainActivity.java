package app.noctis.player;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NoctisPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
