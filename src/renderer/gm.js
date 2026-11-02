/**
 * 通用 MIDI（GM）音色名称表，用于界面显示与回退。
 */
export const GM_PROGRAMS = [
    ['大钢琴', 'Acoustic Grand Piano'], ['明亮钢琴', 'Bright Acoustic Piano'], ['电钢琴', 'Electric Grand Piano'],
    ['酒吧钢琴', 'Honky-tonk Piano'], ['电钢琴1', 'Electric Piano 1'], ['电钢琴2', 'Electric Piano 2'],
    ['羽管键琴', 'Harpsichord'], ['克拉维内特', 'Clavi'], ['钢片琴', 'Celesta'], ['钟琴', 'Glockenspiel'],
    ['音乐盒', 'Music Box'], ['颤音琴', 'Vibraphone'], ['马林巴', 'Marimba'], ['木琴', 'Xylophone'],
    ['管钟', 'Tubular Bells'], ['扬琴', 'Dulcimer'], ['拉杆风琴', 'Drawbar Organ'], ['打击风琴', 'Percussive Organ'],
    ['摇滚风琴', 'Rock Organ'], ['教堂管风琴', 'Church Organ'], ['簧风琴', 'Reed Organ'], ['手风琴', 'Accordion'],
    ['口琴', 'Harmonica'], ['探戈手风琴', 'Tango Accordion'], ['尼龙弦吉他', 'Acoustic Guitar (nylon)'],
    ['钢弦吉他', 'Acoustic Guitar (steel)'], ['爵士吉他', 'Electric Guitar (jazz)'], ['清音吉他', 'Electric Guitar (clean)'],
    ['闷音吉他', 'Electric Guitar (muted)'], ['过载吉他', 'Overdriven Guitar'], ['失真吉他', 'Distortion Guitar'],
    ['吉他泛音', 'Guitar harmonics'], ['原声贝斯', 'Acoustic Bass'], ['电贝斯(指)', 'Electric Bass (finger)'],
    ['电贝斯(拨片)', 'Electric Bass (pick)'], ['无品贝斯', 'Fretless Bass'], ['击弦贝斯1', 'Slap Bass 1'],
    ['击弦贝斯2', 'Slap Bass 2'], ['合成贝斯1', 'Synth Bass 1'], ['合成贝斯2', 'Synth Bass 2'], ['小提琴', 'Violin'],
    ['中提琴', 'Viola'], ['大提琴', 'Cello'], ['低音提琴', 'Contrabass'], ['颤弓弦乐', 'Tremolo Strings'],
    ['拨弦', 'Pizzicato Strings'], ['竖琴', 'Orchestral Harp'], ['定音鼓', 'Timpani'], ['弦乐合奏1', 'String Ensemble 1'],
    ['弦乐合奏2', 'String Ensemble 2'], ['合成弦乐1', 'Synth Strings 1'], ['合成弦乐2', 'Synth Strings 2'],
    ['人声啊', 'Choir Aahs'], ['人声呜', 'Voice Oohs'], ['合成人声', 'Synth Voice'], ['管弦乐齐奏', 'Orchestra Hit'],
    ['小号', 'Trumpet'], ['长号', 'Trombone'], ['大号', 'Tuba'], ['弱音小号', 'Muted Trumpet'], ['圆号', 'French Horn'],
    ['铜管乐团', 'Brass Section'], ['合成铜管1', 'Synth Brass 1'], ['合成铜管2', 'Synth Brass 2'],
    ['高音萨克斯', 'Soprano Sax'], ['中音萨克斯', 'Alto Sax'], ['次中音萨克斯', 'Tenor Sax'], ['上低音萨克斯', 'Baritone Sax'],
    ['双簧管', 'Oboe'], ['英国管', 'English Horn'], ['巴松管', 'Bassoon'], ['单簧管', 'Clarinet'], ['短笛', 'Piccolo'],
    ['长笛', 'Flute'], ['竖笛', 'Recorder'], ['排箫', 'Pan Flute'], ['吹瓶', 'Blown Bottle'], ['尺八', 'Shakuhachi'],
    ['口哨', 'Whistle'], ['陶笛', 'Ocarina'], ['主音1(方波)', 'Lead 1 (square)'], ['主音2(锯齿)', 'Lead 2 (sawtooth)'],
    ['主音3(汽笛)', 'Lead 3 (calliope)'], ['主音4(吹管)', 'Lead 4 (chiff)'], ['主音5(沙朗)', 'Lead 5 (charang)'],
    ['主音6(人声)', 'Lead 6 (voice)'], ['主音7(五度)', 'Lead 7 (fifths)'], ['主音8(贝斯+主音)', 'Lead 8 (bass + lead)'],
    ['铺底1(新世纪)', 'Pad 1 (new age)'], ['铺底2(温暖)', 'Pad 2 (warm)'], ['铺底3(复音)', 'Pad 3 (polysynth)'],
    ['铺底4(合唱)', 'Pad 4 (choir)'], ['铺底5(弓弦)', 'Pad 5 (bowed)'], ['铺底6(金属)', 'Pad 6 (metallic)'],
    ['铺底7(光环)', 'Pad 7 (halo)'], ['铺底8(扫频)', 'Pad 8 (sweep)'], ['效果1(雨)', 'FX 1 (rain)'],
    ['效果2(音轨)', 'FX 2 (soundtrack)'], ['效果3(水晶)', 'FX 3 (crystal)'], ['效果4(氛围)', 'FX 4 (atmosphere)'],
    ['效果5(明亮)', 'FX 5 (brightness)'], ['效果6(精灵)', 'FX 6 (goblins)'], ['效果7(回声)', 'FX 7 (echoes)'],
    ['效果8(科幻)', 'FX 8 (sci-fi)'], ['西塔琴', 'Sitar'], ['班卓琴', 'Banjo'], ['三味线', 'Shamisen'], ['古筝', 'Koto'],
    ['卡林巴', 'Kalimba'], ['风笛', 'Bagpipe'], ['fiddle', 'Fiddle'], ['唢呐', 'Shanai'], ['叮当铃', 'Tinkle Bell'],
    ['阿果果', 'Agogo'], ['钢鼓', 'Steel Drums'], ['木鱼', 'Woodblock'], ['太鼓', 'Taiko Drum'], ['旋律鼓', 'Melodic Tom'],
    ['合成鼓', 'Synth Drum'], ['反向镲', 'Reverse Cymbal'], ['吉他滑弦噪音', 'Guitar Fret Noise'],
    ['呼吸噪音', 'Breath Noise'], ['海浪', 'Seashore'], ['鸟鸣', 'Bird Tweet'], ['电话铃', 'Telephone Ring'],
    ['直升机', 'Helicopter'], ['掌声', 'Applause'], ['枪声', 'Gunshot'],
];

export const DRUM_NOTES = {
    35: '底鼓2', 36: '底鼓1', 37: '边击', 38: '军鼓', 39: '掌声', 40: '电军鼓', 41: '低落地鼓', 42: '闭合踩镲',
    43: '高落地鼓', 44: '脚踏踩镲', 45: '低鼓', 46: '开镲', 47: '低中鼓', 48: '高中鼓', 49: '吊镲1', 50: '高鼓',
    51: '叮叮镲1', 52: '中国镲', 53: '铃鼓', 54: '铃鼓', 55: '水花镲', 56: '牛铃', 57: '吊镲2', 58: '颤音沙锤',
    59: '叮叮镲2', 60: '高邦戈', 61: '低邦戈', 62: '闷音康加', 63: '开音康加', 64: '低康加', 65: '高蒂姆巴尔',
    66: '低蒂姆巴尔', 67: '高阿果果', 68: '低阿果果', 69: '卡巴萨', 70: '沙锤', 71: '短口哨', 72: '长口哨',
    73: '短刮瓜', 74: '长刮瓜', 75: '克拉维', 76: '高木块', 77: '低木块', 78: '闷音库伊卡', 79: '开音库伊卡',
    80: '闷音三角铁', 81: '开音三角铁',
};

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteName(midi) {
    const n = Math.max(0, Math.min(127, Math.round(midi)));
    return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
}

export function programLabel(program) {
    const p = GM_PROGRAMS[Math.max(0, Math.min(127, program))];
    return p ? `${program + 1}. ${p[0]}` : `程序 ${program}`;
}
