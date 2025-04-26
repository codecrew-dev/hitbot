import path from 'path';

/**
 * 개발 모드와 프로덕션 모드에서 적절한 디렉토리 경로를 반환합니다.
 * ts-node로 실행 시 src 경로를, 빌드 후 실행 시 build 경로를 반환합니다.
 */
export function getSourcePath(): string {
  // ts-node로 실행 중인지 확인
  const isDevelopment = process.argv[0].includes('ts-node') || 
                        process.argv[1].includes('ts-node') || 
                        process.env.NODE_ENV === 'development';
  
  return isDevelopment ? './src' : './build';
}

/**
 * 파일 확장자를 환경에 맞게 반환합니다.
 * 개발 환경에서는 .ts, 프로덕션에서는 .js를 반환합니다.
 */
export function getFileExtension(): string {
  const isDevelopment = process.argv[0].includes('ts-node') || 
                        process.argv[1].includes('ts-node') || 
                        process.env.NODE_ENV === 'development';
  
  return isDevelopment ? '.ts' : '.js';
}

/**
 * 개발/프로덕션 환경에 맞는 import 경로를 생성합니다.
 */
export function createImportPath(basePath: string, category: string, file: string): string {
  const isDevelopment = process.argv[0].includes('ts-node') || 
                        process.argv[1].includes('ts-node') || 
                        process.env.NODE_ENV === 'development';
  
  // src 또는 build를 기준으로 import 경로 구성
  const sourcePath = isDevelopment ? 'src' : 'build';
  
  // 파일 이름에서 확장자 제거 (이미 .js 또는 .ts가 있을 수 있음)
  const fileName = file.replace(/\.(js|ts)$/, '');
  
  return path.join('..', basePath, category, fileName);
}
