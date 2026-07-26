package config

var (
	ServerURL       string = ""
	Token           string = ""
	Interval        int    = 120
	CollectInterval int    = 60
	ReportInterval  int    = 300
	ProxyURL        string = ""
	// ConfigFilePath 本地配置文件路径（用于服务端下发配置的原子持久化，空则仅内存生效）
	ConfigFilePath string = ""
	// AgentVersion 探针自身版本（由 cmd 层在启动时注入，上报请求以 X-Agent-Version 携带）
	AgentVersion string = ""
)
