const fs = require('fs');
const filePath = 'src/services/notificationService.ts';
let content = fs.readFileSync(filePath, 'utf8');

const startMarker = "async getKBOLineup(gameId: string): Promise<{ lineupData: any }> {";
const endMarker = "  /**\n   * 팀 코드에 맞는 색상 코드를 반환합니다";

const startIndex = content.indexOf(startMarker);
const endIndex = content.indexOf(endMarker);

if (startIndex !== -1 && endIndex !== -1) {
  const codeBefore = content.substring(0, startIndex);
  const codeAfter = content.substring(endIndex);

  const newFunction = `async getKBOLineup(gameId: string): Promise<{ lineupData: any }> {
    try {
      const { data } = await axios.get(\`https://api-gw.sports.naver.com/schedule/games/\${gameId}/preview\`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        }
      });
      
      if (!data?.success || !data?.result?.previewData) {
        return { lineupData: [] };
      }
      
      const { gameInfo, awayTeamLineUp, homeTeamLineUp } = data.result.previewData;
      const awayList = awayTeamLineUp?.fullLineUp || [];
      const homeList = homeTeamLineUp?.fullLineUp || [];
      
      const lineupData: any[] = [];
      
      if (awayList.length > 0) {
        lineupData.push({
          teamName: gameInfo.aName,
          players: awayList.map((p: any) => p.positionName === "선발투수" ? \`[선발] \${p.playerName} (투수)\` : \`\${p.batorder ? p.batorder + '. ' : ''}\${p.playerName} (\${p.positionName})\`)
        });
      }
      
      if (homeList.length > 0) {
        lineupData.push({
          teamName: gameInfo.hName,
          players: homeList.map((p: any) => p.positionName === "선발투수" ? \`[선발] \${p.playerName} (투수)\` : \`\${p.batorder ? p.batorder + '. ' : ''}\${p.playerName} (\${p.positionName})\`)
        });
      }
      
      return { lineupData };
    } catch (error) {
      console.error('API 라인업 조회 오류 (notificationService):', error);
      return { lineupData: [] };
    }
  }

`;

  fs.writeFileSync(filePath, codeBefore + newFunction + codeAfter);
  console.log("Successfully replaced getKBOLineup in notificationService.ts");
} else {
  console.log("Could not find start or end markers. startIndex: " + startIndex + ", endIndex: " + endIndex);
}
