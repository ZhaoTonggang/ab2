importScripts('./7z/js7z.js');
// 定义数据块大小
const chunkSize = 1024 * 1024, // 1MB/块
	sendStatus = (message) => { // 用于向主线程发送状态更新
		self.postMessage({
			type: 'status',
			data: message
		});
	},
	sendError = (error) => { // 用于向主线程发送错误
		self.postMessage({
			type: 'error',
			error: error.message || error
		});
	},
	formatBytes = (bytes) => { // 辅助函数：格式化字节数（KB/MB）
		if (bytes === 0) return '0 KB';
		const k = 1024;
		// 先将字节转换为 KB
		const kb = bytes / k;
		// 限制单位范围：仅 KB 和 MB
		if (kb < k) {
			// 小于 1024 KB，显示 KB
			return kb.toFixed(2) + ' KB';
		} else {
			// 大于等于 1024 KB，显示 MB
			return (kb / k).toFixed(2) + ' MB';
		}
	},
	withRetry = async (fn) => { // 自动重试工具函数：最多重试 maxRetries 次，失败后等待 1000 再试
			const maxRetries = 5;
			let lastError;
			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				try {
					return await fn(attempt);
				} catch (err) {
					lastError = err;
					if (attempt < maxRetries) {
						await new Promise(resolve => setTimeout(resolve, 1000));
					}
				}
			}
			throw lastError;
		},
		runInSlices = async (task) => { // 分段执行函数
				const taskIterator = task(),
					executeSlice = async () => {
						let startTime = performance.now(),
							result;
						do {
							result = taskIterator.next();
							if (result.done) break;
						} while (performance.now() - startTime < 50);
						if (!result.done) {
							await new Promise(resolve => setTimeout(resolve, 10));
							return executeSlice();
						}
						return result.value;
					}
				return executeSlice();
			},
			downloadWithSlices = async (path, title, progressCallback = null) => {
				return await withRetry(async (attempt) => {
					if (attempt > 0) {
						sendStatus(`${title} 第${attempt}次重试...`);
					}
					const response = await fetch(path);
					if (!response.ok) throw new Error(
						`下载失败：${response.status} ${response.statusText}`);
					const totalSize = Number(response.headers.get('Content-Length')) || 0;
					const reader = response.body.getReader();
					let chunks = [],
						totalReceived = 0;
					while (true) {
						const {
							done,
							value
						} = await reader.read();
						if (done) break;
						chunks.push(value);
						totalReceived += value.length;
						if (progressCallback) {
							progressCallback(totalReceived, totalSize);
						} else {
							if (totalSize) {
								sendStatus(
									`${title}(${totalReceived}/${totalSize})`
								);
							} else {
								sendStatus(
									`${title}(${formatBytes(totalReceived)})`
								);
							}
						}
						await new Promise(resolve => setTimeout(resolve, 0));
					}
					const buffer = new Uint8Array(totalReceived);
					let position = 0;
					for (const chunk of chunks) {
						buffer.set(chunk, position);
						position += chunk.length;
					}
					return {
						buffer,
						datalen: totalSize || totalReceived
					}
				});
			};
// 监听主线程消息
(async () => {
	let js7z = null;
	const paths = Array.from({
			length: 4
		}, (_, i) => 'https://ab2.heheda.top/roms/data.7z.00' + String(i + 1)),
		zName = 'data',
		volumeNames = [];
	try {
		let cache = null,
			extractTarget = zName; // 用于记录最终传给 js7z.callMain 的文件路径
		// 初始化JS7z实例
		sendStatus('正在初始化...');
		js7z = await new Promise((resolve, reject) => {
			JS7z({
				locateFile: () => './7z/js7z.wasm',
				print: (str) => str.trim() && (console.log(str), sendStatus(str)),
				printErr: (str) => str.trim() && (console.error(str), sendStatus(str)),
				noExitRuntime: true
			}).then(resolve).catch(reject);
		});
		if (!js7z) throw new Error('初始化失败！');
		// 打开缓存
		sendStatus('正在检查缓存...');
		cache = await caches.open('GameData');
		// 每个数据包独立下载 → 写 VFS → 按数据包缓存
		const pathlen = paths.length;
		sendStatus(`准备下载 ${pathlen} 个数据包...`);
		// 先检查缓存中是否所有数据包都存在
		let allCached = true;
		for (let i = 0; i < pathlen; i++) {
			const volName = `${zName}.${String(i + 1).padStart(3, '0')}`,
				cachedResp = await cache.match(volName);
			if (!cachedResp) {
				allCached = false;
				break;
			}
		}
		if (allCached) {
			sendStatus(`正在从缓存加载 ${pathlen} 个数据包...`);
			for (let i = 0; i < pathlen; i++) {
				const volName = `${zName}.${String(i + 1).padStart(3, '0')}`,
					cachedResp = await cache.match(volName),
					data = new Uint8Array(await cachedResp.arrayBuffer()),
					stream = js7z.FS.open(volName, 'w+'); // 写入 VFS
				try {
					const blen = data.length;
					let pos = 0;
					while (pos < blen) {
						const end = Math.min(pos + chunkSize, blen);
						js7z.FS.write(stream, data.subarray(pos, end), 0, end - pos);
						pos = end;
					}
				} finally {
					js7z.FS.close(stream);
				}
				volumeNames.push(volName);
			}
		} else {
			// 有缺失 → 并行下载所有数据包
			sendStatus(`正在并行下载 ${pathlen} 个数据包...`);
			let lastStatusTime = 0;
			const volProgress = new Array(pathlen).fill(0),
				volSizes = new Array(pathlen).fill(0),
				downloadTasks = paths.map((path, i) => {
					const volName = `${zName}.${String(i + 1).padStart(3, '0')}`,
						progressCallback = (received, size) => {
							volProgress[i] = received;
							volSizes[i] = size || 0;
							const now = performance.now();
							if (now - lastStatusTime < 200) return;
							lastStatusTime = now;
							const totalReceived = volProgress.reduce((a, b) => a + b, 0),
								totalSize = volSizes.reduce((a, b) => a + b, 0) || 81148977;
							sendStatus(`数据包下载中... ` +
								`(${formatBytes(totalReceived)}/${formatBytes(totalSize)}) ${Math.floor((totalReceived / totalSize) * 100)}%`
							);
						};
					return downloadWithSlices(path, `数据包${i + 1}`, progressCallback)
						.then(result => ({
							volName,
							data: result.buffer,
							datalen: result.datalen,
							index: i,
							success: true
						}))
						.catch(err => ({
							volName,
							index: i,
							success: false,
							error: err
						}));
				});
			const results = await Promise.all(downloadTasks),
				failed = results.filter(r => !r.success);
			if (failed.length > 0) throw new Error(`数据包下载失败: ${failed.map(f => f.volName).join(', ')}`);
			const sortedResults = results
				.filter(r => r.success)
				.sort((a, b) => a.index - b.index);
			sendStatus(`所有数据包下载完成，正在写入...`);
			const totalWriteBytes = sortedResults.reduce((sum, r) => sum + r.data.length, 0),
				sortedRlen = sortedResults.length;
			let writtenBytes = 0;
			for (let i = 0; i < sortedRlen; i++) {
				const result = sortedResults[i];
				const {
					volName,
					datalen
				} = result;
				let data = result.data;
				await runInSlices(function*() {
					let stream = null;
					try {
						stream = js7z.FS.open(volName, 'w+');
						const blen = data.length;
						let pos = 0;
						while (pos < blen) {
							const end = Math.min(pos + chunkSize, blen);
							js7z.FS.write(stream, data.subarray(pos, end), 0, end - pos);
							pos = end;
							sendStatus(
								`正在写入数据... [当前:${volName} | 第:${i + 1}个 / 共:${sortedRlen}个] (${formatBytes(writtenBytes + pos)}/${formatBytes(totalWriteBytes)})`
							);
							yield;
						}
					} finally {
						if (stream) js7z.FS.close(stream);
					}
				});
				writtenBytes += data.length;
				cache.put(volName, new Response(data, {
					headers: {
						'Content-Type': 'application/x-7z-compressed',
						'Content-Length': datalen
					}
				})).catch((err) => {
					console.error(`缓存数据包 ${volName} 失败：`, err);
				});
				data = null;
				result.data = null;
				volumeNames.push(volName);
			}
		}
		// 让 7z 处理数据包合并与解压
		extractTarget = volumeNames[0];
		sendStatus(`正在让 7z 处理数据包并解压...`);
		// 执行解压（传入目标文件：单文件直接 zName；多数据包传 zName.001）
		sendStatus("正在解压数据...");
		js7z.callMain(['x', extractTarget, '-p2585649532', '-aoa', '-y']);
		// 读取解压后的文件并发送给主线程
		const dataBuffer = js7z.FS.readFile('angry.data.unityweb').buffer,
			codeBuffer = js7z.FS.readFile('angry.wasm.code.unityweb').buffer,
			frameworkBuffer = js7z.FS.readFile('angry.wasm.framework.unityweb').buffer,
			jsonBuffer = js7z.FS.readFile('angry.json').buffer,
			jsBuffer = js7z.FS.readFile('UnityLoader.js').buffer,
			GMDBuffer = js7z.FS.readFile('StreamingAssets/GameMasterData.json').buffer,
			VIBuffer = js7z.FS.readFile('StreamingAssets/VersionInformation.txt').buffer,
			LTBuffer = js7z.FS.readFile('StreamingAssets/LoadingTips.txt').buffer,
			LOBuffer = js7z.FS.readFile('StreamingAssets/LevelOverrides.txt').buffer,
			CFBuffer = js7z.FS.readFile('StreamingAssets/CrashFilters.txt').buffer,
			ACBuffer = js7z.FS.readFile('StreamingAssets/ArenaConfiguration.txt').buffer,
			BLESBuffer = js7z.FS.readFile('StreamingAssets/BrandedLevelEventSchedule.json').buffer;
		self.postMessage({
			type: 'complete',
			data: {
				dataBuffer: dataBuffer,
				codeBuffer: codeBuffer,
				frameworkBuffer: frameworkBuffer,
				jsonBuffer: jsonBuffer,
				jsBuffer: jsBuffer,
				GMDBuffer: GMDBuffer,
				VIBuffer: VIBuffer,
				LTBuffer: LTBuffer,
				LOBuffer: LOBuffer,
				CFBuffer: CFBuffer,
				ACBuffer: ACBuffer,
				BLESBuffer: BLESBuffer
			}
		}, [dataBuffer, codeBuffer, frameworkBuffer, jsonBuffer, jsBuffer, GMDBuffer,
			VIBuffer, LTBuffer, LOBuffer, CFBuffer, ACBuffer, BLESBuffer
		]); // 转移ArrayBuffer所有权
	} catch (err) {
		sendError(err);
	} finally {
		// 清理资源：数据包模式清理所有数据包文件
		if (js7z && js7z.FS) {
			try {
				for (const v of volumeNames) {
					if (js7z.FS.analyzePath(v).exists) js7z.FS.unlink(v);
				}
			} catch (e) {
				console.error('清理7z文件失败：', e);
			}
		}
	}
})();