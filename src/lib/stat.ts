class Statistics {
    count: number;
    last1min: number[];
    last5min: number[];
    last15min: number[];
    constructor() {
        this.count = 0;
        this.last1min = [];
        this.last5min = [];
        this.last15min = [];
    }
    record() {
        this.count++;
        const now = Date.now();
        this.last1min.push(now);
        this.last5min.push(now);
        this.last15min.push(now);
        Statistics.vaccumTime(now, 60, this.last1min);
        Statistics.vaccumTime(now, 300, this.last5min);
        Statistics.vaccumTime(now, 900, this.last15min);
        return this.getStat();
    }
    getStat() {
        return {
            count: this.count,
            last1min: this.last1min.length.toFixed(2),
            last5min: (this.last5min.length / 5).toFixed(2),
            last15min: (this.last15min.length / 15).toFixed(2)
        }
    }
    static vaccumTime(now: number, period: number, last: number[]) {
        for (const time of last) {
            if (now - time > period * 1000) {
                last.shift();
            } else {
                break;
            }
        }
    }
}

export default Statistics;
