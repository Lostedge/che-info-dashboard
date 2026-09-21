"""
SQL 查询
"""

# 堆场设备作业统计（RTG、FL、RS）
YM_STATS = """
    SELECT
        SUBSTR(CY_MACH_NO, -3)                                         AS id,
        COUNT(CASE WHEN CNTR_SIZ_COD = '20' THEN 1 END)                AS day_20,
        COUNT(CASE WHEN CNTR_SIZ_COD = '40' THEN 1 END)                AS day_40,
        COUNT(CASE WHEN CNTR_SIZ_COD = '20'
                   AND WORK_TIM >= :period_start THEN 1 END)           AS period_20,
        COUNT(CASE WHEN CNTR_SIZ_COD = '40'
                   AND WORK_TIM >= :period_start THEN 1 END)           AS period_40
    FROM JZCT_TOS_HIS.CY_COMMAND
    WHERE WORK_TIM IS NOT NULL
      AND WORK_TIM >= :day_start
      AND WORK_TIM <  :period_end
      AND CY_MACH_NO IS NOT NULL
      AND QUEUE_TYP IN ('SI','SO','TI','TO')
    GROUP BY CY_MACH_NO
    ORDER BY CY_MACH_NO
"""

# 岸桥作业统计
QC_STATS = """
    SELECT
        SUBSTR(SHIP_MACH_NO, -3)                                       AS id,
        COUNT(CASE WHEN CNTR_SIZ_COD = '20' THEN 1 END)                AS day_20,
        COUNT(CASE WHEN CNTR_SIZ_COD = '40' THEN 1 END)                AS day_40,
        COUNT(CASE WHEN CNTR_SIZ_COD = '20'
                   AND WORK_TIM >= :period_start THEN 1 END)           AS period_20,
        COUNT(CASE WHEN CNTR_SIZ_COD = '40'
                   AND WORK_TIM >= :period_start THEN 1 END)           AS period_40
    FROM JZCT_TOS_HIS.SHIP_COMMAND
    WHERE WORK_TIM IS NOT NULL
      AND WORK_TIM >= :day_start
      AND WORK_TIM <  :period_end
      AND SHIP_MACH_NO IS NOT NULL
    GROUP BY SHIP_MACH_NO
    ORDER BY SHIP_MACH_NO
"""

# 堆场设备信息（RTG、FL；FL 附位置 area/bay）
YM_INFO = """
    SELECT
        SUBSTR(p.MACH_NO, -3)                       AS id,
        p.CURRENT_ID                                AS status,
        COALESCE(o.OPER_NAM, p.MACH_OPER_COD)       AS driver,
        p.WORK_WAY                                  AS work_way,
        CASE WHEN p.MACH_NO LIKE 'DGJ%' 
             THEN p.CUR_CY_AREA_NO END              AS area,
        CASE WHEN p.MACH_NO LIKE 'DGJ%' 
             THEN p.CUR_CY_BAY_NO  END              AS bay
    FROM JZCT_TOS.CY_MACH_PLAC p
    LEFT JOIN JZCT_CODE.C_OPERATOR o ON p.MACH_OPER_COD = o.OPER_COD
    WHERE p.MACH_NO LIKE 'CQ%'
       OR p.MACH_NO LIKE 'DGJ%'
"""

# 岸桥设备信息
QC_INFO = """
    SELECT
        SUBSTR(p.MACH_NO, -3)                       AS id,
        p.CURRENT_ID                                AS status,
        COALESCE(o.OPER_NAM, p.MACH_OPER_COD)       AS driver,
        COALESCE(v.SHIP_NAM, p.VOYAGE_NO)           AS ship_name,
        p.WORK_WAY                                  AS work_way,
        p.CUR_BAY_NO                                AS bay
    FROM JZCT_TOS.SHIP_MACH_PLAC p
    LEFT JOIN JZCT_CODE.C_OPERATOR o ON p.MACH_OPER_COD = o.OPER_COD
    LEFT JOIN JZCT_TOS_HIS.SHIP_VOYAGE v ON p.VOYAGE_NO = v.VOYAGE_NO
    WHERE p.MACH_NO IN ('AQ101','AQ102','AQ103','AQ104','AQ105','AQ106')
"""

# 船舶信息
SHIP_INFO = """
    SELECT
        p.VOYAGE_NO                                             AS id,
        p.SHIP_STAT_ID                                          AS status,
        p.SHIP_NAM                                              AS ship_name,
        COALESCE(p.I_VOYAGE, '-') 
            || '/' 
            || COALESCE(p.E_VOYAGE, '-')                        AS voyage,
        p.BERTH_COD                                             AS berth,
        p.ETA                                                   AS eta,
        p.RTB                                                   AS rtb,
        p.BEG_WORK_TIM                                          AS beg_work_tim
    FROM JZCT_TOS_HIS.SHIP_VOYAGE p
    WHERE (p.SHIP_STAT_ID IN ('Y', 'C', 'D')
        OR (p.SHIP_STAT_ID = 'E'
            AND p.ETA >= SYSDATE
            AND p.ETA <  SYSDATE + INTERVAL '1' DAY))
"""

# 船舶作业进度
SHIP_PROGRESS = """
    SELECT
        s.VOYAGE_NO                                                         AS id,
        COUNT(CASE WHEN v.I_E_ID = 'I' THEN 1 END)                          AS i_plan_num,
        COUNT(CASE WHEN v.I_E_ID = 'I'
                   AND v.WORK_TIM IS NOT NULL THEN 1 END)                   AS i_done_num,
        COUNT(CASE WHEN v.I_E_ID = 'I'
                   AND v.COMM_STATUS IS NOT NULL THEN 1 END)                AS i_queue_num,
        COUNT(CASE WHEN v.I_E_ID = 'E' THEN 1 END)                          AS e_plan_num,
        COUNT(CASE WHEN v.I_E_ID = 'E'
                   AND v.WORK_TIM IS NOT NULL THEN 1 END)                   AS e_done_num,
        COUNT(CASE WHEN v.I_E_ID = 'E'
                   AND v.COMM_STATUS IS NOT NULL THEN 1 END)                AS e_queue_num
    FROM JZCT_TOS_HIS.SHIP s
    LEFT JOIN JZCT_TOS.V_SAS_SHIP_MONITOR_QRY v ON s.SHIP_NO = v.SHIP_NO
    WHERE s.VOYAGE_NO IN ({voyages})
    GROUP BY s.VOYAGE_NO
"""

# 岸桥 move 数：按整点小时桶统计
# 双吊 = 相邻两行（同一岸桥，按 WORK_TIM 排序）间隔 <30s 且同车号且都是 20 尺，合并计 1 move；其余每行计 1
# 预读窗口必须 >= 下面的 30s 阈值，否则窗口首行会被误判为新 move
QC_MOVE_HOUR = """
    SELECT id, bucket, SUM(is_new) AS moves
    FROM (
        SELECT SUBSTR(SHIP_MACH_NO, -3)                                AS id,
               TO_CHAR(TRUNC(WORK_TIM, 'HH24'), 'YYYY-MM-DD HH24:MI')  AS bucket,
               CASE WHEN prev_tim IS NULL
                      OR (WORK_TIM - prev_tim) * 86400 >= 30           -- 间隔 ≥30s → 新 move
                      OR NVL(TRUCK_NO, '~') <> NVL(prev_trk, '~')      -- 车号不同 → 新 move
                      OR CNTR_SIZ_COD <> '20'                          -- 非双 20 → 新 move
                      OR prev_siz <> '20'
                    THEN 1 ELSE 0 END                                  AS is_new
        FROM (
            SELECT SHIP_MACH_NO, WORK_TIM, TRUCK_NO, CNTR_SIZ_COD,
                   LAG(WORK_TIM)     OVER (PARTITION BY SHIP_MACH_NO
                                           ORDER BY WORK_TIM, TRUCK_NO, CNTR) AS prev_tim,
                   LAG(TRUCK_NO)     OVER (PARTITION BY SHIP_MACH_NO
                                           ORDER BY WORK_TIM, TRUCK_NO, CNTR) AS prev_trk,
                   LAG(CNTR_SIZ_COD) OVER (PARTITION BY SHIP_MACH_NO
                                           ORDER BY WORK_TIM, TRUCK_NO, CNTR) AS prev_siz
            FROM JZCT_TOS_HIS.SHIP_COMMAND
            WHERE WORK_TIM >= :win_start - INTERVAL '1' MINUTE            -- 预读，仅供 LAG
              AND WORK_TIM <  :win_end
              AND SHIP_MACH_NO IN ('AQ101','AQ102','AQ103','AQ104','AQ105','AQ106')
        )
        WHERE WORK_TIM >= :win_start                                      -- 只统计目标窗口
    )
    GROUP BY id, bucket
    ORDER BY id, bucket
"""

# ============================================================
# 当班统计：换班检测
# ============================================================

# 堆场设备换班检测+补偿：返回换司机设备的 id/当班起点，及 [换班点, 检测点) 的 20/40 补偿量
SHIFT_DETECT_CY = """
    SELECT SUBSTR(CY_MACH_NO, -3)                                AS id,
           MAX(shift_start)                                      AS shift_start,
           COUNT(CASE WHEN CNTR_SIZ_COD = '20' THEN 1 END)       AS comp_20,
           COUNT(CASE WHEN CNTR_SIZ_COD = '40' THEN 1 END)       AS comp_40
    FROM (
        SELECT CY_MACH_NO, CNTR_SIZ_COD, WORK_TIM,
               MAX(CASE WHEN is_switch = 1 THEN WORK_TIM END)
                   OVER (PARTITION BY CY_MACH_NO)                AS shift_start
        FROM (
            SELECT CY_MACH_NO, CNTR_SIZ_COD, WORK_TIM,
                   CASE WHEN prev_nam IS NOT NULL AND prev_nam <> REPLACE_NAM
                        THEN 1 ELSE 0 END                        AS is_switch
            FROM (
                SELECT CY_MACH_NO, CNTR_SIZ_COD, WORK_TIM, REPLACE_NAM,
                       LAG(REPLACE_NAM) OVER (PARTITION BY CY_MACH_NO ORDER BY WORK_TIM) AS prev_nam
                FROM JZCT_TOS_HIS.CY_COMMAND
                WHERE WORK_TIM >= :lookback
                  AND WORK_TIM <  :check_time
                  AND CY_MACH_NO IS NOT NULL
            )
        )
    )
    WHERE WORK_TIM >= shift_start
    GROUP BY SUBSTR(CY_MACH_NO, -3)
"""

# 岸桥换班检测+补偿
SHIFT_DETECT_QC = """
    SELECT SUBSTR(SHIP_MACH_NO, -3)                              AS id,
           MAX(shift_start)                                      AS shift_start,
           COUNT(CASE WHEN CNTR_SIZ_COD = '20' THEN 1 END)       AS comp_20,
           COUNT(CASE WHEN CNTR_SIZ_COD = '40' THEN 1 END)       AS comp_40
    FROM (
        SELECT SHIP_MACH_NO, CNTR_SIZ_COD, WORK_TIM,
               MAX(CASE WHEN is_switch = 1 THEN WORK_TIM END)
                   OVER (PARTITION BY SHIP_MACH_NO)              AS shift_start
        FROM (
            SELECT SHIP_MACH_NO, CNTR_SIZ_COD, WORK_TIM,
                   CASE WHEN prev_nam IS NOT NULL AND prev_nam <> SHIP_MACH_DRIVER
                        THEN 1 ELSE 0 END                        AS is_switch
            FROM (
                SELECT SHIP_MACH_NO, CNTR_SIZ_COD, WORK_TIM, SHIP_MACH_DRIVER,
                       LAG(SHIP_MACH_DRIVER) OVER (PARTITION BY SHIP_MACH_NO ORDER BY WORK_TIM) AS prev_nam
                FROM JZCT_TOS_HIS.SHIP_COMMAND
                WHERE WORK_TIM >= :lookback
                  AND WORK_TIM <  :check_time
                  AND SHIP_MACH_NO IS NOT NULL
            )
        )
    )
    WHERE WORK_TIM >= shift_start
    GROUP BY SUBSTR(SHIP_MACH_NO, -3)
"""
