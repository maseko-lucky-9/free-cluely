import React, { useState, useEffect } from 'react';

interface ModelConfig {
  provider: "ollama";
  model: string;
  isOllama: boolean;
}

interface ModelSelectorProps {
  onModelChange?: (model: string) => void;
  onChatOpen?: () => void;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({ onModelChange, onChatOpen }) => {
  const [currentConfig, setCurrentConfig] = useState<ModelConfig | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState<'testing' | 'success' | 'error' | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [ollamaUrl, setOllamaUrl] = useState<string>("http://localhost:11434");

  useEffect(() => {
    loadCurrentConfig();
  }, []);

  const loadCurrentConfig = async () => {
    try {
      setIsLoading(true);
      const config = await window.electronAPI.getCurrentLlmConfig();
      setCurrentConfig(config);
      if (config.model) setSelectedModel(config.model);
      // Always load the model list. The old version only loaded it when already
      // in Ollama mode, so the picker showed "No models found" with 22 installed.
      await loadModels(config.model);
    } catch (error) {
      console.error('Error loading current config:', error);
      setErrorMessage(String(error));
    } finally {
      setIsLoading(false);
    }
  };

  const loadModels = async (preferred?: string) => {
    try {
      const models = await window.electronAPI.getAvailableOllamaModels();
      setAvailableModels(models);
      // Select what is actually in use, never a blind models[0].
      setSelectedModel((current) => {
        if (current && models.includes(current)) return current;
        if (preferred && models.includes(preferred)) return preferred;
        return models[0] ?? "";
      });
    } catch (error) {
      console.error('Error loading Ollama models:', error);
      setAvailableModels([]);
      setErrorMessage(String(error));
    }
  };

  const testConnection = async () => {
    try {
      setConnectionStatus('testing');
      setErrorMessage('');
      const result = await window.electronAPI.testLlmConnection();
      setConnectionStatus(result.success ? 'success' : 'error');
      if (!result.success) setErrorMessage(result.error || 'Unknown error');
    } catch (error) {
      setConnectionStatus('error');
      setErrorMessage(String(error));
    }
  };

  const applyChanges = async () => {
    try {
      setConnectionStatus('testing');
      setErrorMessage('');
      // switchToOllama now validates the model exists and supports vision before
      // reporting success, so a green status can be trusted.
      const result = await window.electronAPI.switchToOllama(selectedModel, ollamaUrl);

      if (result.success) {
        await loadCurrentConfig();
        setConnectionStatus('success');
        onModelChange?.(selectedModel);
        setTimeout(() => onChatOpen?.(), 500);
      } else {
        setConnectionStatus('error');
        setErrorMessage(result.error || 'Switch failed');
      }
    } catch (error) {
      setConnectionStatus('error');
      setErrorMessage(String(error));
    }
  };

  const getStatusColor = () => {
    switch (connectionStatus) {
      case 'testing': return 'text-yellow-600';
      case 'success': return 'text-green-600';
      case 'error': return 'text-red-600';
      default: return 'text-gray-600';
    }
  };

  const getStatusText = () => {
    switch (connectionStatus) {
      case 'testing': return 'Testing connection...';
      case 'success': return 'Connected successfully';
      case 'error': return `Error: ${errorMessage}`;
      default: return 'Ready';
    }
  };

  if (isLoading) {
    return (
      <div className="p-4 bg-white/20 backdrop-blur-md rounded-lg border border-white/30">
        <div className="animate-pulse text-sm text-gray-600">Loading model configuration...</div>
      </div>
    );
  }

  return (
    <div className="p-4 bg-white/20 backdrop-blur-md rounded-lg border border-white/30 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800">Local Model (Ollama)</h3>
        <div className={`text-xs ${getStatusColor()}`}>{getStatusText()}</div>
      </div>

      {currentConfig?.model && (
        <div className="text-xs text-gray-600 bg-white/40 p-2 rounded">
          Current: 🏠 {currentConfig.model}
        </div>
      )}

      <div className="space-y-2">
        <div>
          <label className="text-xs font-medium text-gray-700">Ollama URL</label>
          <input
            type="url"
            value={ollamaUrl}
            onChange={(e) => setOllamaUrl(e.target.value)}
            className="w-full px-3 py-2 text-xs bg-white/40 border border-white/60 rounded focus:outline-none focus:ring-2 focus:ring-green-400/60"
          />
        </div>

        <div>
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-gray-700">Vision model</label>
            <button
              onClick={() => loadModels()}
              className="px-2 py-1 text-xs bg-white/60 hover:bg-white/80 rounded transition-all"
              title="Refresh models"
            >
              🔄
            </button>
          </div>

          {availableModels.length > 0 ? (
            <>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-white/40 border border-white/60 rounded focus:outline-none focus:ring-2 focus:ring-green-400/60"
              >
                {availableModels.map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
              <div className="text-[10px] text-gray-500 mt-1">
                Only vision-capable models are listed — this app sends screenshots.
              </div>
            </>
          ) : (
            <div className="text-xs text-gray-700 bg-yellow-100/60 p-2 rounded">
              No vision-capable model found. Start Ollama and run:
              <code className="block mt-1 font-mono">ollama pull qwen2.5vl:7b</code>
            </div>
          )}
        </div>
      </div>

      <div className="flex gap-2 pt-2">
        <button
          onClick={applyChanges}
          disabled={connectionStatus === 'testing' || !selectedModel}
          className="flex-1 px-3 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 text-white text-xs rounded transition-all shadow-md"
        >
          {connectionStatus === 'testing' ? 'Switching...' : 'Apply Changes'}
        </button>

        <button
          onClick={testConnection}
          disabled={connectionStatus === 'testing'}
          className="px-3 py-2 bg-gray-500 hover:bg-gray-600 disabled:bg-gray-400 text-white text-xs rounded transition-all shadow-md"
        >
          Test
        </button>
      </div>

      <div className="text-xs text-gray-600">
        💡 Runs entirely on this machine. No API key, nothing leaves the device.
      </div>
    </div>
  );
};

export default ModelSelector;
