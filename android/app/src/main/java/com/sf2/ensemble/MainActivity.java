package com.sf2.ensemble;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.sf2ensemble.midi.MidiBridgePlugin;
import com.sf2ensemble.synth.SynthBridgePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MidiBridgePlugin.class);
        registerPlugin(SynthBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
